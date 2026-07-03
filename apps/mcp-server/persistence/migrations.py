import hashlib
from dataclasses import dataclass
from pathlib import Path
from time import monotonic

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

_BOOTSTRAP_SQL = """
CREATE TABLE IF NOT EXISTS mcp_schema_migrations (
    version INT UNSIGNED NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    checksum CHAR(64) NOT NULL,
    execution_ms INT UNSIGNED NOT NULL,
    applied_by VARCHAR(255) NOT NULL,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
""".strip()


@dataclass(frozen=True, slots=True)
class Migration:
    version: int
    name: str
    path: Path
    sql: str
    checksum: str


def discover_migrations(directory: Path) -> list[Migration]:
    migrations: list[Migration] = []
    for path in sorted(directory.glob("[0-9][0-9][0-9]_*.sql")):
        sql = path.read_text(encoding="utf-8")
        version = int(path.name[:3])
        migrations.append(
            Migration(
                version=version,
                name=path.stem[4:],
                path=path,
                sql=sql,
                checksum=hashlib.sha256(sql.encode()).hexdigest(),
            )
        )
    versions = [migration.version for migration in migrations]
    if versions != list(range(1, len(migrations) + 1)):
        raise ValueError(f"migration versions must be contiguous from 001: {versions}")
    return migrations


def split_sql_statements(sql: str) -> list[str]:
    statements: list[str] = []
    buffer: list[str] = []
    quote: str | None = None
    index = 0
    while index < len(sql):
        char = sql[index]
        next_char = sql[index + 1] if index + 1 < len(sql) else ""
        if quote is not None:
            buffer.append(char)
            if char == "\\" and index + 1 < len(sql):
                index += 1
                buffer.append(sql[index])
            elif char == quote:
                quote = None
        elif char in {"'", '"', "`"}:
            quote = char
            buffer.append(char)
        elif char == "-" and next_char == "-":
            index += 2
            while index < len(sql) and sql[index] != "\n":
                index += 1
            buffer.append("\n")
            continue
        elif char == "#":
            while index < len(sql) and sql[index] != "\n":
                index += 1
            buffer.append("\n")
            continue
        elif char == "/" and next_char == "*":
            index += 2
            while index + 1 < len(sql) and sql[index : index + 2] != "*/":
                index += 1
            index += 1
        elif char == ";":
            statement = "".join(buffer).strip()
            if statement:
                statements.append(statement)
            buffer = []
        else:
            buffer.append(char)
        index += 1
    trailing = "".join(buffer).strip()
    if trailing:
        statements.append(trailing)
    return statements


class MigrationChecksumMismatch(RuntimeError):
    pass


class MigrationRunner:
    def __init__(
        self,
        engine: AsyncEngine,
        migration_directory: Path,
        *,
        lock_name: str = "ypmcn:mcp-schema-migrations",
        applied_by: str = "mcp-migration-runner",
    ) -> None:
        self._engine = engine
        self._directory = migration_directory
        self._lock_name = lock_name
        self._applied_by = applied_by

    async def plan(self) -> list[Migration]:
        migrations = discover_migrations(self._directory)
        async with self._engine.connect() as connection:
            table_exists = await connection.scalar(
                text(
                    "SELECT COUNT(*) FROM information_schema.TABLES "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mcp_schema_migrations'"
                )
            )
            if not table_exists:
                return migrations
            result = await connection.execute(
                text("SELECT version, checksum FROM mcp_schema_migrations ORDER BY version")
            )
            applied = dict(result.all())
        self._verify_checksums(migrations, applied)
        return [migration for migration in migrations if migration.version not in applied]

    async def migrate(self) -> list[Migration]:
        migrations = discover_migrations(self._directory)
        applied_now: list[Migration] = []
        async with self._engine.connect() as connection:
            acquired = await connection.scalar(
                text("SELECT GET_LOCK(:name, 30)"), {"name": self._lock_name}
            )
            if acquired != 1:
                raise TimeoutError("could not acquire the MySQL migration advisory lock")
            try:
                await connection.execute(text(_BOOTSTRAP_SQL))
                result = await connection.execute(
                    text("SELECT version, checksum FROM mcp_schema_migrations ORDER BY version")
                )
                applied = dict(result.all())
                self._verify_checksums(migrations, applied)
                for migration in migrations:
                    if migration.version in applied:
                        continue
                    started_at = monotonic()
                    for statement in split_sql_statements(migration.sql):
                        await connection.execute(text(statement))
                    execution_ms = max(0, round((monotonic() - started_at) * 1000))
                    await connection.execute(
                        text(
                            "INSERT INTO mcp_schema_migrations "
                            "(version, name, checksum, execution_ms, applied_by) "
                            "VALUES (:version, :name, :checksum, :execution_ms, :applied_by)"
                        ),
                        {
                            "version": migration.version,
                            "name": migration.name,
                            "checksum": migration.checksum,
                            "execution_ms": execution_ms,
                            "applied_by": self._applied_by,
                        },
                    )
                    await connection.commit()
                    applied_now.append(migration)
            finally:
                await connection.execute(
                    text("SELECT RELEASE_LOCK(:name)"),
                    {"name": self._lock_name},
                )
        return applied_now

    @staticmethod
    def _verify_checksums(migrations: list[Migration], applied: dict[int, str]) -> None:
        expected = {migration.version: migration.checksum for migration in migrations}
        for version, checksum in applied.items():
            if expected.get(version) != checksum:
                raise MigrationChecksumMismatch(
                    f"migration {version:03d} checksum differs from the applied migration"
                )

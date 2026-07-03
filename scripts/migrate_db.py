import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "mcp-server"))

from config import DatabaseSettings  # noqa: E402
from persistence.connection import create_database_engine  # noqa: E402
from persistence.migrations import MigrationRunner  # noqa: E402


async def run(apply: bool) -> None:
    settings = DatabaseSettings.from_mapping()
    engine = create_database_engine(settings)
    runner = MigrationRunner(engine, ROOT / "db" / "migrations")
    try:
        pending = await runner.plan()
        if not apply:
            for migration in pending:
                print(f"{migration.version:03d} {migration.name} {migration.checksum}")
            print(f"pending={len(pending)}")
            return
        applied = await runner.migrate()
        for migration in applied:
            print(f"applied {migration.version:03d} {migration.name} {migration.checksum}")
        print(f"applied_count={len(applied)}")
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Plan or apply YPmcn MySQL migrations")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="apply pending migrations; without this flag the command is read-only",
    )
    arguments = parser.parse_args()
    asyncio.run(run(arguments.apply))


if __name__ == "__main__":
    main()

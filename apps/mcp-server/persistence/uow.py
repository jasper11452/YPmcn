from types import TracebackType

from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncTransaction


class MySqlUnitOfWork:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self.connection: AsyncConnection | None = None
        self._transaction: AsyncTransaction | None = None

    async def __aenter__(self) -> "MySqlUnitOfWork":
        self.connection = await self._engine.connect()
        self._transaction = await self.connection.begin()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        try:
            if self._transaction is not None:
                if exc_type is None:
                    await self._transaction.commit()
                else:
                    await self._transaction.rollback()
        finally:
            if self.connection is not None:
                await self.connection.close()

    def require_connection(self) -> AsyncConnection:
        if self.connection is None:
            raise RuntimeError("unit of work is not active")
        return self.connection

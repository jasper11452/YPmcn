export function mysqlConfigFromEnv() {
    return {
        host: process.env.MYSQL_HOST ?? "localhost",
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER ?? "root",
        password: process.env.MYSQL_PASSWORD ?? "",
        database: process.env.MYSQL_DATABASE ?? "test",
    };
}
export async function fetchCreatorRows(_config, _sourceMapping, _maxRows) {
    return [];
}

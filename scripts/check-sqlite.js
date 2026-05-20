let driver = null;
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES('hello');");
  const r = db.prepare("SELECT * FROM t WHERE t MATCH 'hello'").all();
  if (r.length !== 1) throw new Error('FTS5 sanity check failed');
  db.close();
  driver = 'better-sqlite3';
} catch (e) {
  try {
    require.resolve('sql.js');
    driver = 'sql.js';
  } catch (e2) {
    console.error('No SQLite driver available (better-sqlite3 native build failed AND sql.js not installed).');
    process.exit(1);
  }
}
console.log(driver);

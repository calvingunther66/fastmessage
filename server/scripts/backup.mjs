/**
 * Write a consistent snapshot of the SQLite database to DATA_DIR/backups/.
 * Safe to run against the live server: it folds the WAL into the main file
 * (checkpoint) and then copies it. The copy keeps the source's encryption.
 *
 *   DATA_DIR=/data DB_ENCRYPTION_KEY=... node server/scripts/backup.mjs
 *
 * Attachment blobs live in DATA_DIR/blobs — back that directory up too
 * (e.g. rsync the whole data volume).
 */
import Database from "better-sqlite3-multiple-ciphers";
import { copyFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const dir = isAbsolute(DATA_DIR) ? DATA_DIR : resolve(process.cwd(), DATA_DIR);
const key = process.env.DB_ENCRYPTION_KEY || "";

const backups = join(dir, "backups");
mkdirSync(backups, { recursive: true });

const src = join(dir, "fastmessage.sqlite");
const db = new Database(src);
if (key) db.pragma(`key='${key.replace(/'/g, "''")}'`);
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = join(backups, `fastmessage-${stamp}.sqlite`);
copyFileSync(src, dest);
console.log("backup written:", dest);

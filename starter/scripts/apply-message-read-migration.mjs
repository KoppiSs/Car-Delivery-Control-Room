import 'dotenv/config'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
try {
  const migration = await readFile(new URL('../migrations/0005_message_read.sql', import.meta.url), 'utf8')
  await sql.begin(async (tx) => { await tx.unsafe(migration) })
  const [column] = await sql`select data_type,is_nullable,column_default from information_schema.columns
    where table_schema='public' and table_name='messages' and column_name='is_read'`
  assert.equal(column?.data_type, 'boolean')
  assert.equal(column.is_nullable, 'NO')
  assert.equal(column.column_default, 'false')
  const [counts] = await sql`select count(*)::int as total,count(*) filter (where not is_read)::int as unread from messages`
  console.log(`Applied messages.is_read: boolean NOT NULL DEFAULT false. ${counts.total} messages retained; ${counts.unread} unread.`)
} finally { await sql.end() }

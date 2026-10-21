import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { openDatabase, backupDatabase, writeCursor } from "../src/lib/db.ts";

type Db = ReturnType<typeof openDatabase>;

/** The query plan SQLite would use for `sql`, as one readable line. */
function queryPlan(db: Db, sql: string, args: unknown[] = []): string {
  return db
    // A fixed prefix over fixed test SQL; no request data is involved.
    // eslint-disable-next-line no-restricted-syntax
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(args as never[]))
    .map((r) => String((r as { detail: string }).detail))
    .join(" | ");
}

describe("summary query indexes", () => {
  test("migrate creates the covering indexes", () => {
    const db = openDatabase(":memory:");
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    assert.ok(names.includes("mandates_merchant_status_period_amount"));
    assert.ok(names.includes("charges_merchant_amount"));
    assert.ok(names.includes("charges_subscriber_amount_fee"));
    db.close();
  });

  test("merchant summary queries use covering indexes, not table scans", () => {
    const db = openDatabase(":memory:");

    const active = queryPlan(
      db,
      "SELECT COUNT(*) AS n FROM mandates WHERE merchant = ? AND status = 'Active'",
      ["M"],
    );
    assert.match(active, /COVERING INDEX/);
    assert.doesNotMatch(active, /SCAN mandates\b/);

    const collected = queryPlan(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total, COUNT(*) AS n FROM charges WHERE merchant = ?",
      ["M"],
    );
    assert.match(collected, /COVERING INDEX/);
    assert.doesNotMatch(collected, /SCAN charges\b/);

    const recurring = queryPlan(
      db,
      `SELECT COALESCE(SUM(CAST(amount AS INTEGER) * 2592000 / period), 0) AS mrr
         FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
      ["M"],
    );
    assert.match(recurring, /COVERING INDEX/);
    assert.doesNotMatch(recurring, /SCAN mandates\b/);

    db.close();
  });

  test("subscriber summary total uses a covering index", () => {
    const db = openDatabase(":memory:");
    const paid = queryPlan(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE subscriber = ?",
      ["S"],
    );
    assert.match(paid, /COVERING INDEX/);
    assert.doesNotMatch(paid, /SCAN charges\b/);
    db.close();
  });
});

describe("database backup", () => {
  test("produces a consistent copy that opens and reads the same data", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payflow-backup-"));
    try {
      const primary = path.join(dir, "primary.db");
      const backup = path.join(dir, "backup.db");

      const db = openDatabase(primary);
      // Seed some data through the projection tables.
      db.prepare("INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger) VALUES (1, 'M', 'Pro', 'T', '1000', 2592000, 1, 100)").run();
      db.prepare("INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, last_charge, charges_made, max_charges, fee_bps, status, ledger) VALUES (1, 'S', 'M', 1, '1000', 2592000, 1700000000, 0, 0, 0, 100, 'Active', 100)").run();
      db.prepare("INSERT INTO charges (tx_hash, mandate_id, subscriber, merchant, amount, fee, charges_made, next_charge, ledger, created_at) VALUES ('tx-1', 1, 'S', 'M', '990', '10', 1, 1700000000, 100, 1700000000)").run();
      writeCursor(db, 100);
      db.close();

      backupDatabase(openDatabase(primary), backup);

      const copy = openDatabase(backup);
      const plan = copy.prepare("SELECT * FROM plans WHERE id = 1").get() as { name: string; amount: string };
      assert.equal(plan.name, "Pro");
      assert.equal(plan.amount, "1000");

      const mandate = copy.prepare("SELECT * FROM mandates WHERE id = 1").get() as { status: string; charges_made: number };
      assert.equal(mandate.status, "Active");
      assert.equal(mandate.charges_made, 0);

      const charge = copy.prepare("SELECT COUNT(*) AS n FROM charges").get() as { n: number };
      assert.equal(charge.n, 1);

      const cursor = copy.prepare("SELECT last_ledger FROM cursor WHERE id = 1").get() as { last_ledger: number };
      assert.equal(cursor.last_ledger, 100);

      copy.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("backup of an in-memory database writes a readable file", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payflow-backup-"));
    try {
      const backup = path.join(dir, "mem-backup.db");

      const db = openDatabase(":memory:");
      db.prepare("INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger) VALUES (1, 'M', 'Pro', 'T', '1000', 2592000, 1, 100)").run();
      db.close();

      backupDatabase(openDatabase(":memory:"), backup);
      assert.ok(fs.existsSync(backup), "backup file was created");
      assert.ok(fs.statSync(backup).size > 0, "backup file is not empty");

      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      // no-op: cleaned in try
    }
  });
});

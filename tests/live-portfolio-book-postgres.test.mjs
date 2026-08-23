import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import pg from "pg";

// 迁移 0060：实盘组合的真实本金，以及「部署 mode 必须与组合 book 一致」。
//
// 这些检查挡的是一类不会报错的错误：真实成交被记进一本本金写死 10000 的账。
// 那本账上算出来的回撤、日亏、绩效分成全都是虚构的，而没有任何一步会失败。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `book_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

// 只复刻本次迁移涉及的结构，不拉整条迁移链——那会让这个测试变成迁移链测试。
before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE official_paper_portfolios (
      id text PRIMARY KEY,
      membership_id text NOT NULL,
      strategy_code text NOT NULL,
      book text NOT NULL DEFAULT 'paper' CHECK (book IN ('paper','live')),
      principal_usdt numeric(30,12) NOT NULL,
      exchange_account_id text,
      CONSTRAINT principal_check CHECK (
        (book = 'paper' AND principal_usdt = 10000)
        OR (book = 'live' AND principal_usdt > 0)
      ),
      CONSTRAINT live_has_account CHECK ((book = 'live') = (exchange_account_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX uq_card_book ON official_paper_portfolios (membership_id, strategy_code, book);
    CREATE UNIQUE INDEX uq_id_book ON official_paper_portfolios (id, book);

    CREATE OR REPLACE FUNCTION protect_official_paper_principal()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.principal_usdt <> OLD.principal_usdt THEN
        RAISE EXCEPTION 'official paper principal is immutable';
      END IF;
      IF NEW.book <> OLD.book THEN
        RAISE EXCEPTION 'portfolio book is immutable';
      END IF;
      IF NEW.book = 'paper' AND NEW.principal_usdt <> 10000 THEN
        RAISE EXCEPTION 'official paper principal is immutable';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER trg_protect BEFORE UPDATE ON official_paper_portfolios
      FOR EACH ROW EXECUTE FUNCTION protect_official_paper_principal();

    CREATE TABLE strategy_deployments (
      id text PRIMARY KEY,
      mode text NOT NULL CHECK (mode IN ('shadow','paper','live')),
      paper_portfolio_id text,
      portfolio_book text GENERATED ALWAYS AS
        (CASE WHEN mode = 'live' THEN 'live' ELSE 'paper' END) STORED,
      FOREIGN KEY (paper_portfolio_id, portfolio_book)
        REFERENCES official_paper_portfolios (id, book)
    );
  `);
  await pool.query(`INSERT INTO official_paper_portfolios VALUES
    ('p-paper','m1','ai_balanced','paper',10000,NULL),
    ('p-live','m1','ai_balanced','live',3000,'acct-1')`);
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

async function rejects(sql, params, pattern, why) {
  await assert.rejects(() => pool.query(sql, params), pattern, why);
}

test("模拟盘本金仍然锁死在 10000", async () => {
  await rejects(
    "INSERT INTO official_paper_portfolios VALUES ('x','m2','ai_balanced','paper',3000,NULL)",
    [], /principal_check/, "模拟盘的产品规则不能因为放宽实盘而松动",
  );
});

test("实盘本金可以是客户真实投入的任意正数", async () => {
  await pool.query("INSERT INTO official_paper_portfolios VALUES ('y','m2','ai_balanced','live',3333.5,'acct-2')");
  const { rows } = await pool.query("SELECT principal_usdt FROM official_paper_portfolios WHERE id='y'");
  assert.equal(Number(rows[0].principal_usdt), 3333.5);
  await rejects(
    "INSERT INTO official_paper_portfolios VALUES ('z','m3','ai_balanced','live',0,'acct-3')",
    [], /principal_check/, "本金为 0 的实盘组合会让所有百分比风控除以零",
  );
});

test("实盘组合必须绑账户，模拟盘组合不许绑", async () => {
  await rejects("INSERT INTO official_paper_portfolios VALUES ('a','m4','ai_balanced','live',1000,NULL)",
    [], /live_has_account/, "不知道对着哪个账户的实盘账等于没有账");
  await rejects("INSERT INTO official_paper_portfolios VALUES ('b','m4','ai_balanced','paper',10000,'acct-9')",
    [], /live_has_account/, "模拟盘挂着真实账户是「以为在模拟、其实随时可能真下单」的前置条件");
});

test("同一张卡上模拟盘与实盘各一本账，同 book 不得重复", async () => {
  // 客户先跑模拟再上实盘是正常路径，两本账要能共存。
  const { rows } = await pool.query(
    "SELECT book FROM official_paper_portfolios WHERE membership_id='m1' AND strategy_code='ai_balanced' ORDER BY book");
  assert.deepEqual(rows.map(r => r.book), ["live", "paper"]);
  await rejects("INSERT INTO official_paper_portfolios VALUES ('dup','m1','ai_balanced','paper',10000,NULL)",
    [], /uq_card_book/);
});

test("本金与 book 都不可改", async () => {
  // 追加资金必须走显式入金流程留痕。直接改大 principal 等于抹掉客户此前的亏损，
  // 让平台对没赚回来的部分收绩效分成（INV-5）。
  await rejects("UPDATE official_paper_portfolios SET principal_usdt=5000 WHERE id='p-live'",
    [], /principal is immutable/);
  await rejects("UPDATE official_paper_portfolios SET book='paper', exchange_account_id=NULL WHERE id='p-live'",
    [], /book is immutable/);
});

test("实盘部署无法指向模拟盘组合——这是记假账的唯一入口", async () => {
  await rejects("INSERT INTO strategy_deployments (id,mode,paper_portfolio_id) VALUES ('d1','live','p-paper')",
    [], /portfolio_book|foreign key/, "真实成交记进本金 10000 的账，不会报错，只会算错");
  await rejects("INSERT INTO strategy_deployments (id,mode,paper_portfolio_id) VALUES ('d2','paper','p-live')",
    [], /portfolio_book|foreign key/, "反向同样致命：模拟决策记进实盘账");
});

test("mode 与 book 一致时放行，且 book 由 mode 推出而非写入方填写", async () => {
  await pool.query("INSERT INTO strategy_deployments (id,mode,paper_portfolio_id) VALUES ('d3','live','p-live')");
  await pool.query("INSERT INTO strategy_deployments (id,mode,paper_portfolio_id) VALUES ('d4','paper','p-paper')");
  const { rows } = await pool.query("SELECT id, portfolio_book FROM strategy_deployments ORDER BY id");
  assert.deepEqual(rows, [{ id: "d3", portfolio_book: "live" }, { id: "d4", portfolio_book: "paper" }]);
  // 生成列不接受写入——写入方无从填错，这正是选生成列而不是普通列的理由。
  await rejects("INSERT INTO strategy_deployments (id,mode,paper_portfolio_id,portfolio_book) VALUES ('d5','live','p-live','paper')",
    [], /non-DEFAULT value into column "portfolio_book"/);
});

test("shadow 与 paper 共用同一本模拟账", async () => {
  await pool.query("INSERT INTO strategy_deployments (id,mode,paper_portfolio_id) VALUES ('d6','shadow','p-paper')");
  const { rows } = await pool.query("SELECT portfolio_book FROM strategy_deployments WHERE id='d6'");
  assert.equal(rows[0].portfolio_book, "paper", "shadow 不下真实单，账本身份与 paper 相同");
});

/**
 * Regression for 「找不到密鑰：E2B_API_KEY … 設定也是找不到」: the full 設定 → 密鑰 flow in a real browser (add, listed after
 * reload, edit, server errors visible in the dialog) and a chat whose http_request uses {{secret:E2B_API_KEY}}.
 */
import { expect, test, type Page } from "@playwright/test";
import { api, ensureSetup, MOCK_LLM } from "./support/setup";

async function clearSecrets(page: Page) {
  const { secrets } = await api(page, "/secrets");
  for (const s of secrets) await api(page, `/secrets/${s.id}`, "DELETE");
}

async function toolResultFor(prompt: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const r = await (await fetch(`${MOCK_LLM}/tool-result?prompt=${encodeURIComponent(prompt)}`)).json();
    if (r.result) return r.result;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("no tool result reached the model");
}

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder(/輸入訊息/);
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await ensureSetup(page);
  await api(page, "/permissions/mode", "PUT", { scope: "global", mode: "full" });
  await clearSecrets(page);
});

test("add E2B_API_KEY in 設定 → 密鑰, listed after reload, usable by http_request", async ({ page }) => {
  // 1. No secrets at all: the model gets told so (not a vague name mismatch).
  const p0 = `密鑰測試 無密鑰 ${Date.now()}`;
  await page.goto("/");
  await send(page, p0);
  const r0 = await toolResultFor(p0);
  expect(r0).toContain("找不到密鑰：E2B_API_KEY");
  expect(r0).toContain("目前沒有任何已儲存的密鑰");

  // 2. UI flow: name typed with surrounding spaces, domain pasted as a URL.
  await page.goto("/settings?tab=secrets");
  await expect(page.getByText("尚未新增任何密鑰")).toBeVisible();
  await page.getByRole("button", { name: "新增密鑰" }).click();
  await page.getByLabel("名稱").fill(" E2B_API_KEY ");
  await page.getByLabel("值").fill("e2b_test_value_123456");
  await page.getByLabel("允許網域").fill("https://api.e2b.app/");
  await page.getByRole("button", { name: "儲存" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const row = page.getByRole("tabpanel").getByRole("listitem").filter({ hasText: "E2B_API_KEY" });
  await expect(row).toBeVisible();
  await expect(row.getByText("api.e2b.app")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("tabpanel").getByRole("listitem").filter({ hasText: "E2B_API_KEY" })).toBeVisible();
  const { secrets } = await api(page, "/secrets");
  expect(secrets.map((s: any) => s.name)).toEqual(["E2B_API_KEY"]);
  expect(secrets[0].allowedDomains).toEqual(["api.e2b.app"]);

  // 3. A duplicate is refused with the server's message shown IN the dialog (and the dialog stays open).
  await page.getByRole("button", { name: "新增密鑰" }).click();
  await page.getByLabel("名稱").fill("E2B_API_KEY");
  await page.getByLabel("值").fill("another_value_123");
  await page.getByLabel("允許網域").fill("api.e2b.app");
  await page.getByRole("button", { name: "儲存" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("已有名為 E2B_API_KEY 的密鑰");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();

  // 4. A fullwidth name is normalized (ＥＲＲ_ＫＥＹ → ERR_KEY); an invalid one is refused visibly.
  await page.getByRole("button", { name: "新增密鑰" }).click();
  await page.getByLabel("名稱").fill("MY-KEY");
  await page.getByLabel("值").fill("value_1234");
  await page.getByLabel("允許網域").fill("api.example.com");
  await page.getByRole("button", { name: "儲存" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("名稱只能使用英文字母、數字與底線");
  await page.getByLabel("名稱").fill("ＭＹ＿ＫＥＹ");
  await page.getByRole("button", { name: "儲存" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("tabpanel").getByRole("listitem").filter({ hasText: "MY_KEY" })).toBeVisible();

  // 5. Chat: the secret is found (whatever the network then does, it is not 「找不到密鑰」).
  const p1 = `密鑰測試 已設定 ${Date.now()}`;
  await page.goto("/");
  await send(page, p1);
  const r1 = await toolResultFor(p1);
  expect(r1).not.toContain("找不到密鑰");
  expect(r1).not.toContain("e2b_test_value_123456");

  // 6. A wrong name lists the names that do exist.
  await api(page, `/secrets/${secrets[0].id}`, "PATCH", { name: "E2B_KEY" });
  const p2 = `密鑰測試 名稱不符 ${Date.now()}`;
  await page.goto("/");
  await send(page, p2);
  const r2 = await toolResultFor(p2);
  expect(r2).toContain("找不到密鑰：E2B_API_KEY");
  expect(r2).toContain("E2B_KEY");
});

test("a failed tool call with a body never shows an empty result", async ({ page }) => {
  const p = `密鑰測試 本文 ${Date.now()}`;
  await page.goto("/");
  await send(page, p);
  await toolResultFor(p);
  // The tool card shows the error text (not an empty box) once expanded.
  const card = page.getByText("http_request").first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByText(/找不到密鑰：E2B_API_KEY/).first()).toBeVisible();
});

test("server failures are visible: list error with 重試, save error kept in the dialog, outside click keeps typed input", async ({ page }) => {
  // GET /api/secrets failing (e.g. missing migration / ENCRYPTION_KEY on a deploy) → message in the card, not a spinner.
  let failList = true;
  await page.route("**/api/secrets", (route) =>
    route.request().method() === "GET" && failList
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal_error", message: 'relation "secrets" does not exist' }) })
      : route.fallback());
  await page.goto("/settings?tab=secrets");
  await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText('無法載入密鑰清單：relation "secrets" does not exist');
  failList = false;
  await page.getByRole("button", { name: "重試" }).click();
  await expect(page.getByText("尚未新增任何密鑰")).toBeVisible();

  // A click outside the dialog must not throw away what was typed.
  await page.getByRole("button", { name: "新增密鑰" }).click();
  await page.getByLabel("名稱").fill("E2B_API_KEY");
  await page.getByLabel("值").fill("e2b_value_999999");
  await page.mouse.click(5, 5);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("名稱")).toHaveValue("E2B_API_KEY");

  // POST failing → the server's message inside the dialog, which stays open.
  await page.route("**/api/secrets", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal_error", message: "Decryption key invalid" }) })
      : route.fallback());
  await page.getByLabel("允許網域").fill("api.e2b.app");
  await page.getByRole("button", { name: "儲存" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("儲存失敗：Decryption key invalid");
  await expect(page.getByRole("dialog")).toBeVisible();
});

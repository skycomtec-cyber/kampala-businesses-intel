import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("KIP_E2E_BASE", "http://127.0.0.1:4399")
errors = []
failures = []

def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))
    if not condition:
        failures.append(label)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    def on_console(m):
        if m.type != "error":
            return
        # An optional-session probe (/auth/me) answering 401 is expected for an
        # anonymous visitor and is the same noise the other pages already make.
        if "401" in m.text and "Unauthorized" in m.text:
            return
        errors.append(f"console.{m.type}: {m.text}")
    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    # --- the ask page, with example questions ready ------------------------
    page.goto(f"{BASE}/ask.html")
    page.wait_for_load_state("networkidle")
    check("ask page renders the question box", page.locator("#ask-q").is_visible())
    check("example questions offered", page.locator("#examples button").count() >= 1,
          str(page.locator("#examples button").count()))

    # --- a count question: the reading is the answer -----------------------
    page.fill("#ask-q", "how many device repair businesses are in Kampala District")
    page.click("#ask-form button[type=submit]")
    try:
        page.wait_for_selector("#count:not(:empty)", timeout=5000)
    except Exception:
        pass
    check("answer section shown", page.locator("#answer-section").is_visible())
    check("read as a count", page.locator("#reading-intent").inner_text().strip() == "count",
          page.locator("#reading-intent").inner_text())
    check("subject resolved to a category", page.locator("#reading-subject").inner_text().strip() != "not recognised",
          page.locator("#reading-subject").inner_text())
    check("place resolved to the geography", page.locator("#reading-place").inner_text().strip() != "not recognised",
          page.locator("#reading-place").inner_text())
    check("a sentence explains the answer", page.locator("#reading-note").inner_text().strip() != "",
          page.locator("#reading-note").inner_text())

    # --- a find question: the free text is what search is for --------------
    page.fill("#ask-q", "laptop repair in Kampala District")
    page.click("#ask-form button[type=submit]")
    page.wait_for_timeout(800)
    check("read as a find", page.locator("#reading-intent").inner_text().strip() == "find a business",
          page.locator("#reading-intent").inner_text())
    check("unmatched subject kept as search terms",
          "laptop repair" in page.locator("#reading-text").inner_text().lower(),
          page.locator("#reading-text").inner_text())

    # --- second life: the vertical's table of contents ---------------------
    page.goto(f"{BASE}/second-life.html")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector("#activities .activity", timeout=5000)
    cards = page.locator("#activities .activity").count()
    check("six activities listed", cards == 6, f"cards={cards}")
    hrefs = page.locator("#activities .activity a").evaluate_all("els => els.map(e => e.getAttribute('href'))")
    check("each activity links into the directory",
          all(h and "/directory.html" in h for h in hrefs), str(hrefs))

    browser.close()

print("\nconsole/page errors:", len(errors))
for e in errors:
    print("  ", e)

if failures or errors:
    sys.exit(1)
print("\nALL CHECKS PASSED")

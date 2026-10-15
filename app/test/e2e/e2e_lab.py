import datetime
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("KIP_E2E_BASE", "http://127.0.0.1:4399")
EMAIL = os.environ.get("KIP_DEMO_ADMIN_EMAIL", "demo@example.com")
PASSWORD = os.environ.get("KIP_DEMO_ADMIN_PASSWORD", "demo-password-123")
errors = []
failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))
    if not condition:
        failures.append(label)


def monitor(page):
    def on_console(m):
        if m.type != "error":
            return
        url = m.location.get("url", "")
        text = m.text or ""
        # Two expected refusals: the sign-in probe before anyone is signed in, and
        # the dismissal the test makes without a reason to prove the server refuses
        # it. Both are answered, not failed, so neither is a page error.
        if "auth/me" in url and "401" in text:
            return
        if "/admin/lab/opportunities/" in url and "400" in text:
            return
        errors.append(f"console: {m.text} @ {url}")
    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))


def day_offset(days):
    return (datetime.datetime.utcnow() - datetime.timedelta(days=days)).strftime("%Y-%m-%d")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()
    monitor(page)

    # ---------- the gate, then the laboratory ---------------------------------
    page.goto(f"{BASE}/lab.html")
    page.wait_for_load_state("networkidle")
    check("the gate is shown to an anonymous visitor", page.locator("#gate").is_visible())
    check("the laboratory is hidden until sign-in", page.locator("#lab").is_hidden())

    page.fill("#email", EMAIL)
    page.fill("#password", PASSWORD)
    page.click("#sign-in")
    page.wait_for_selector("#lab:not([hidden])", timeout=8000)
    check("the laboratory opens for an admin", page.locator("#lab").is_visible())
    check("the gate is gone once signed in", page.locator("#gate").is_hidden())
    check("the operator is named", EMAIL.split("@")[0] in page.locator("#who-name").inner_text().lower()
          or "demo" in page.locator("#who-name").inner_text().lower())

    # ---------- this run -------------------------------------------------------
    # The counts fill in from /admin/lab/overview. The first cell is "gaps
    # published"; until it is a number the page is still loading.
    page.wait_for_function(
        "document.querySelector('#overview-counts .count b').textContent.trim() !== '\\u2014'",
        timeout=8000,
    )
    counts = page.locator("#overview-counts .count b").all_inner_texts()
    check("the overview shows every figure", len(counts) == 5, str(counts))
    check("a completed run is described", "run" in page.locator("#run-explain").inner_text().lower())
    facts = page.locator("#run-facts").inner_text()
    check("the run facts name the privacy floor", "privacy floor" in facts.lower())
    check("the run is on the runs ledger", page.locator("#runs li.run").count() >= 1,
          f"runs={page.locator('#runs li.run').count()}")

    # ---------- the gaps, floor lifted ----------------------------------------
    page.wait_for_function("document.querySelectorAll('#gaps li.card').length > 0", timeout=8000)
    gap_cards = page.locator("#gaps li.card").count()
    check("the gaps list is populated", gap_cards > 0, f"cards={gap_cards}")

    # A withheld finding is the point of the page: the public route drops it and
    # the laboratory keeps it. Suppressed rows have the fewest actors, so at
    # "biggest first" they sit behind the pager; walk to the page that holds them
    # rather than assuming they are on the first.
    for _ in range(10):
        if page.locator("#gaps li.card .withheld").count() > 0:
            break
        if page.locator("#gaps-next").is_disabled():
            break
        page.click("#gaps-next")
        page.wait_for_timeout(500)
    withheld = page.locator("#gaps li.card .withheld").count()
    check("a withheld finding is visible on the laboratory", withheld > 0, f"withheld={withheld}")
    if withheld > 0:
        card = page.locator("#gaps li.card", has=page.locator(".withheld")).first
        check("the withheld finding keeps the plain surface, not a severity tone",
              card.get_attribute("data-tone") in (None, ""))

    # Filtering to a severity is the one request the operator drives directly.
    page.select_option("#gap-severity", "critical")
    page.wait_for_function(
        "document.getElementById('gaps-problem').textContent.trim() === ''",
        timeout=8000,
    )
    check("a severity filter is answered without a problem", True)

    # ---------- the demand signals --------------------------------------------
    # The area defaults to the place behind the top finding, and a place with a
    # finding has demand, so the section opens on real rows rather than empty.
    page.wait_for_function("document.querySelectorAll('#signals li.card').length > 0", timeout=8000)
    signal_cards = page.locator("#signals li.card").count()
    check("the signals open on the place behind the top finding", signal_cards > 0,
          f"cards={signal_cards}")

    selected = page.locator("#signals-location option:checked")
    check("the default area is a real place, not the country",
          selected.get_attribute("data-kind") != "country",
          f"kind={selected.get_attribute('data-kind')}")

    # The select is populated for the operator to move, and moving it re-reads.
    options = page.locator("#signals-location option").count()
    check("every place is offered as an area", options > 5, f"options={options}")

    # ---------- the opportunity board -----------------------------------------
    page.wait_for_function("document.querySelectorAll('#opportunities li.card').length > 0", timeout=8000)
    board = page.locator("#opportunities li.card").count()
    check("the opportunity board is populated", board > 0, f"cards={board}")

    # The reason is required to dismiss, and the server is the authority on that.
    # The page lets an empty reason through and shows the refusal in the row rather
    # than restating the rule and risking a second definition. The board is ranked,
    # so the top row is the same one before and after a state change - its score does
    # not move - and it can be addressed by position.
    reason = "Overlaps an existing listing; not a separate gap."
    top = page.locator("#opportunities li.card").first
    keyword = top.locator(".name").inner_text()
    top.locator("select").select_option("dismissed")
    top.locator(".board-controls input").fill("")
    top.locator("button", has_text="Record state").click()

    page.wait_for_function(
        "() => { const c = document.querySelector('#opportunities li.card');"
        " const s = c && c.querySelector('.saved');"
        " return s && s.dataset.tone === 'danger' && s.textContent.trim().length > 0; }",
        timeout=8000,
    )
    refused = page.locator("#opportunities li.card").first.locator(".saved").inner_text()
    check("a dismissal with no reason is refused by the server", True, refused)

    # With a reason the move is accepted, and the board is re-read so the top row
    # comes back wearing its new state and the reason behind it.
    row = page.locator("#opportunities li.card").first
    row.locator("input").fill(reason)
    row.locator("button", has_text="Record state").click()
    page.wait_for_function(
        "sel => { const c = document.querySelector('#opportunities li.card');"
        " return c && c.innerText.includes('dismissed') && c.innerText.includes(sel); }",
        arg=reason,
        timeout=8000,
    )
    check("a dismissal with a reason is recorded, and the row keeps it", True, keyword)

    # A dismissed row stays on the board, because the board is the working set.
    page.select_option("#opportunity-state", "dismissed")
    page.wait_for_function(
        "sel => Array.from(document.querySelectorAll('#opportunities li.card'))"
        ".some(c => c.innerText.includes(sel))",
        arg=reason,
        timeout=8000,
    )
    check("the dismissed row stays on the working board", True)

    ctx.close()
    browser.close()

if errors:
    print("\nconsole/page errors:", len(errors))
    for e in errors:
        print("  ", e)

if failures or errors:
    sys.exit(1)
print("\n\nALL CHECKS PASSED")

"""
AROYA Scraper — logs into app.aroya.io with a real browser, captures every XHR
response, and dumps the raw JSON + a flattened readings CSV.

Usage:
    export AROYA_USER="you@company.com"
    export AROYA_PASS="your_password"
    python aroya_scraper.py

Optional env vars (defaults shown):
    AROYA_LOGIN_URL   = https://app.aroya.io/login
    AROYA_TARGET_URLS = https://app.aroya.io/  (comma-separated list)
    AROYA_OUTPUT_DIR  = ./aroya_captures
    AROYA_HEADLESS    = 0   (set to 1 once login works)
    AROYA_USER_FIELD  = email         (CSS selector or name attr)
    AROYA_PASS_FIELD  = password
    AROYA_SUBMIT_BTN  = button[type=submit]
    AROYA_WAIT_SECS   = 20  (seconds to wait after navigation for XHRs to settle)

Install deps (separate from the main Streamlit app):
    pip install selenium selenium-wire webdriver-manager
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

from seleniumwire import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager


# ─── CONFIG ──────────────────────────────────────────────────────────────────
CFG = {
    "user":        os.environ.get("AROYA_USER", ""),
    "password":    os.environ.get("AROYA_PASS", ""),
    "login_url":   os.environ.get("AROYA_LOGIN_URL", "https://app.aroya.io/login"),
    "targets":     [u.strip() for u in os.environ.get("AROYA_TARGET_URLS", "https://app.aroya.io/").split(",") if u.strip()],
    "output_dir":  Path(os.environ.get("AROYA_OUTPUT_DIR", "./aroya_captures")),
    "headless":    os.environ.get("AROYA_HEADLESS", "0") == "1",
    "user_field":  os.environ.get("AROYA_USER_FIELD", "email"),
    "pass_field":  os.environ.get("AROYA_PASS_FIELD", "password"),
    "submit_btn":  os.environ.get("AROYA_SUBMIT_BTN", "button[type=submit]"),
    "wait_secs":   int(os.environ.get("AROYA_WAIT_SECS", "20")),
}


def build_driver():
    opts = Options()
    if CFG["headless"]:
        opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1400,900")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    service = Service(ChromeDriverManager().install())
    return webdriver.Chrome(service=service, options=opts)


def find_field(driver, selector_or_name):
    """Try CSS selector first, then fall back to name=, id=, input[type=email/password]."""
    candidates = [
        (By.CSS_SELECTOR, selector_or_name),
        (By.NAME, selector_or_name),
        (By.ID, selector_or_name),
        (By.CSS_SELECTOR, f"input[name='{selector_or_name}']"),
        (By.CSS_SELECTOR, f"input[type='{selector_or_name}']"),
    ]
    for by, sel in candidates:
        try:
            el = driver.find_element(by, sel)
            if el:
                return el
        except Exception:
            continue
    return None


def login(driver):
    print(f"→ Navigating to login: {CFG['login_url']}")
    driver.get(CFG["login_url"])
    WebDriverWait(driver, 20).until(lambda d: d.execute_script("return document.readyState") == "complete")

    user_el = find_field(driver, CFG["user_field"])
    pass_el = find_field(driver, CFG["pass_field"])
    if not user_el or not pass_el:
        print("✗ Could not locate login fields. Page HTML preview:")
        print(driver.page_source[:2000])
        sys.exit(1)

    print(f"→ Filling credentials as {CFG['user']}")
    user_el.clear(); user_el.send_keys(CFG["user"])
    pass_el.clear(); pass_el.send_keys(CFG["password"])

    # submit
    try:
        driver.find_element(By.CSS_SELECTOR, CFG["submit_btn"]).click()
    except Exception:
        pass_el.submit()

    # wait for URL to change off login page
    try:
        WebDriverWait(driver, 20).until(lambda d: "login" not in d.current_url.lower())
        print(f"✓ Logged in — now at {driver.current_url}")
    except Exception:
        print(f"⚠ Still on login page after 20s. URL = {driver.current_url}")
        print("   If 2FA/SSO, run with AROYA_HEADLESS=0 and complete manually in the browser window, then press Enter here.")
        input("   Press Enter once you're logged in... ")


def capture(driver, url):
    print(f"→ Visiting {url}")
    # Clear requests buffer so we only capture what this page triggers
    del driver.requests
    driver.get(url)
    # Let the page finish making XHRs
    time.sleep(CFG["wait_secs"])

    captures = []
    for req in driver.requests:
        if not req.response:
            continue
        ctype = req.response.headers.get("content-type", "")
        if "json" not in ctype.lower():
            continue
        try:
            body = req.response.body.decode("utf-8", errors="replace")
            payload = json.loads(body)
        except Exception:
            continue
        captures.append({
            "url": req.url,
            "method": req.method,
            "status": req.response.status_code,
            "payload": payload,
        })

    print(f"   Captured {len(captures)} JSON XHR responses")
    return captures


def flatten_readings(all_captures):
    """Best-effort flatten of AROYA-style sensor responses into a uniform rows schema.
    Adjust the field names in METRIC_KEYS / TIMESTAMP_KEYS if AROYA's shapes differ."""
    METRIC_KEYS = {"temperature", "temp_c", "temp_f", "temp",
                   "humidity", "rh", "humidity_pct",
                   "co2", "co2_ppm",
                   "vpd", "vpd_kpa",
                   "moisture", "water_content", "vwc",
                   "ec", "ec_porewater", "ec_bulk",
                   "ph", "par", "ppfd",
                   "soil_temp", "soil_moisture",
                   "value"}
    TIMESTAMP_KEYS = ("timestamp", "time", "recorded_at", "ts", "datetime", "measured_at")

    rows = []
    for cap in all_captures:
        payload = cap["payload"]
        # walk any list-shaped field that looks like readings
        candidates = []
        if isinstance(payload, list):
            candidates.append((None, payload))
        elif isinstance(payload, dict):
            for k, v in payload.items():
                if isinstance(v, list):
                    candidates.append((k, v))

        for _key, items in candidates:
            for item in items:
                if not isinstance(item, dict):
                    continue
                ts = next((item[k] for k in TIMESTAMP_KEYS if k in item), None)
                if ts is None:
                    continue
                for metric in METRIC_KEYS & set(item.keys()):
                    val = item[metric]
                    if val is None or isinstance(val, (list, dict)):
                        continue
                    rows.append({
                        "timestamp": ts,
                        "facility": item.get("facility") or item.get("facility_name") or "",
                        "room": item.get("room") or item.get("room_name") or item.get("zone") or "",
                        "sensor_id": str(item.get("sensor_id") or item.get("id") or item.get("device_id") or ""),
                        "sensor_name": item.get("sensor_name") or item.get("name") or item.get("type") or "",
                        "metric": metric,
                        "value": val,
                        "unit": item.get("unit", ""),
                        "source_url": cap["url"],
                    })
    return rows


def main():
    if not CFG["user"] or not CFG["password"]:
        print("✗ Set AROYA_USER and AROYA_PASS env vars first.")
        sys.exit(1)

    CFG["output_dir"].mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    driver = build_driver()
    try:
        login(driver)

        all_captures = []
        for url in CFG["targets"]:
            all_captures.extend(capture(driver, url))

        # raw dump
        raw_path = CFG["output_dir"] / f"aroya_raw_{stamp}.json"
        raw_path.write_text(json.dumps(all_captures, indent=2, default=str))
        print(f"✓ Wrote raw: {raw_path}  ({raw_path.stat().st_size // 1024} KB)")

        # flattened readings
        rows = flatten_readings(all_captures)
        if rows:
            import csv
            csv_path = CFG["output_dir"] / f"aroya_readings_{stamp}.csv"
            with csv_path.open("w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
            print(f"✓ Wrote {len(rows)} flattened readings: {csv_path}")
        else:
            print("⚠ No readings flattened. Inspect the raw JSON to identify correct field names,")
            print(f"   then update METRIC_KEYS / TIMESTAMP_KEYS in {__file__}.")

        # unique endpoints hit — useful for locking in API paths later
        endpoints = sorted({c["url"] for c in all_captures})
        ep_path = CFG["output_dir"] / f"aroya_endpoints_{stamp}.txt"
        ep_path.write_text("\n".join(endpoints))
        print(f"✓ Wrote {len(endpoints)} unique endpoints: {ep_path}")

    finally:
        driver.quit()


if __name__ == "__main__":
    main()

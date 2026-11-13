"""Shared browser setup for first_time_login.py and instagram_bot.py."""

import os

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service as ChromeService

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

# Override with the BRAVE_PATH environment variable. If the file doesn't
# exist, plain Google Chrome/Chromium is used instead.
BRAVE_PATH = os.environ.get("BRAVE_PATH", "/usr/bin/brave-browser")

# Keeps your Instagram login between runs (created by first_time_login.py).
PROFILE_DIR = os.path.join(PROJECT_DIR, "brave_profile")

# A chromedriver placed in the project folder is used if present. Otherwise
# Selenium Manager (built into Selenium 4.6+) downloads one that matches the
# browser automatically.
LOCAL_DRIVER = os.path.join(PROJECT_DIR, "chromedriver")


def make_driver():
    options = Options()
    if os.path.exists(BRAVE_PATH):
        options.binary_location = BRAVE_PATH
    else:
        print(f"Brave not found at {BRAVE_PATH}; using Chrome/Chromium instead.")
    options.add_argument(f"user-data-dir={PROFILE_DIR}")

    if os.path.exists(LOCAL_DRIVER):
        service = ChromeService(executable_path=LOCAL_DRIVER)
    else:
        service = ChromeService()
    return webdriver.Chrome(service=service, options=options)

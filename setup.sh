#!/bin/bash
# Setup script for the Instagram Follower Analyzer CLI bot.

set -e

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install Python dependencies
pip install -r requirements.txt

echo "Setup complete!"
echo
echo "The bot uses Brave at /usr/bin/brave-browser (set BRAVE_PATH to change it),"
echo "or Google Chrome/Chromium if Brave isn't found. A matching ChromeDriver is"
echo "downloaded automatically by Selenium unless ./chromedriver exists."
echo
echo "To run the bot:"
echo "  source venv/bin/activate"
echo "  python first_time_login.py   # once, to log in and save the session"
echo "  python instagram_bot.py"

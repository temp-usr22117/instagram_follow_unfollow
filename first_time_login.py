from browser import make_driver

print("--- Starting Manual Login Helper ---")

driver = make_driver()

# --- MANUAL LOGIN ---
driver.get("https://www.instagram.com/accounts/login/")
print("\n>>> A browser window has opened.")
print(">>> Please log in to Instagram manually in that window.")
print(">>> Make sure to click 'Save Info' if prompted.")

# This line will keep the script running and the browser open
# until you are done and press Enter here in the terminal.
input("\n>>> Press ENTER here after you have finished logging in. <<<")

driver.quit()
print("--- Login session saved. You can now run the main bot. ---")

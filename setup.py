import subprocess
import sys
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent

print("Installing requirements (MARK XXXIX-OR)...")
subprocess.run(
    [sys.executable, "-m", "pip", "install", "-r", str(ROOT / "requirements-mark.txt")],
    check=True,
)

print("Installing Playwright browsers...")
subprocess.run([sys.executable, "-m", "playwright", "install"], check=True)

# Bootstrap config/api_keys.json from the example if it doesn't exist yet.
keys      = ROOT / "config" / "api_keys.json"
keys_eg   = ROOT / "config" / "api_keys.json.example"
if not keys.exists() and keys_eg.exists():
    shutil.copy(keys_eg, keys)
    print(f"\n📝 Created {keys} — edit it and add your Gemini + OpenRouter keys.")

print("\n✅ Setup complete! Run 'python main.py' to start MARK XXXIX-OR.")

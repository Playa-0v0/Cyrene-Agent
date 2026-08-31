import sys
import os

# Add src to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from log import setup_logging
from auth import login_via_qrcode

if __name__ == "__main__":
    setup_logging("run_login")
    result = login_via_qrcode()
    print(result)

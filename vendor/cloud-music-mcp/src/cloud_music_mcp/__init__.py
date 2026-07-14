"""网易云音乐 MCP Server"""

import sys
import argparse
import asyncio

from .main import mcp


def main():
    """MCP Server CLI 入口"""
    parser = argparse.ArgumentParser(
        description="网易云音乐 MCP Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport type (default: stdio)",
    )

    args = parser.parse_args()

    # FastMCP 直接运行
    mcp.run()


if __name__ == "__main__":
    main()

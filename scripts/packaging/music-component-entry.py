import multiprocessing

from cloud_music_mcp.main import mcp


if __name__ == "__main__":
    multiprocessing.freeze_support()
    mcp.run()

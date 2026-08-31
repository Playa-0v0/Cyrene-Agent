import subprocess
import sys


def test_import_does_not_replace_process_stderr():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; before = sys.stderr; import cloud_music_mcp; "
                "raise SystemExit(0 if sys.stderr is before else 1)"
            ),
        ],
        check=False,
    )

    assert result.returncode == 0

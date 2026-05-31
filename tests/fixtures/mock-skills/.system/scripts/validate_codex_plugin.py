#!/usr/bin/env python3
"""Minimal plugin validate stub for Agency CLI tests."""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin-root", default="")
    args = parser.parse_args()
    payload = {"status": "pass", "plugin_root": args.plugin_root}
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())

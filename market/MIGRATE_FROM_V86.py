#!/usr/bin/env python3
"""Compatibility entry point for v9.1 users: safer v9.2 migration API."""
from MERGE_V86 import cli
import sys
if __name__=='__main__':
    print('Note: this importer now defaults to read-only. Add --apply to commit after successful validation.')
    sys.exit(cli())

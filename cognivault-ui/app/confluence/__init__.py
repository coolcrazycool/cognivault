"""Confluence page-source integration (client, per-user store, routes).

Phase 1 scope: async Confluence REST client, per-user config/secret/manifest
store, and the ``/api/confluence`` config/validate/status routes. The heavy
lifting (storage-XHTML → Markdown conversion, subtree sync) lives in later
phases and is deliberately absent here.
"""

from __future__ import annotations

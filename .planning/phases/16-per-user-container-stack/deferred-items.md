# Deferred Items - Phase 16

## Pre-existing Test Failure

**File:** `src/features/vault/__tests__/routes.test.ts`
**Test:** `returns 200 with empty metadata and warning for malformed YAML`
**Issue:** The test expects `body.warning` to be defined when parsing malformed YAML frontmatter, but `gray-matter` appears to parse the content without throwing an error, resulting in no warning field in the response. This test was already failing before Phase 16 changes.
**Impact:** None on auth changes. Isolated to vault metadata parsing.

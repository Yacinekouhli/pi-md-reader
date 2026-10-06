---
title: Quarterly Handover
owner: platform
---

# Quarterly Handover

Intro paragraph with enough words to exercise wrapping behaviour in a narrow reader viewport,
plus an inline `code span`, a **bold phrase**, and a [link](https://example.com).

## Scope

- Consolidate the gateway servers
- Retire the duplicate registry entries
- Ship the reader

## Numbers

| Metric | Before | After |
| ------ | ------ | ----- |
| Servers | 21 | 21 |
| Feeds | 0 | 1 |

### Risks

1. Auth is still blocked upstream
2. Owners may drift

## Timeline

The rollout needs a preprod rehearsal first, then a two week soak in production before the
Git migration is deleted.

ZEBRA_UNIQUE_TOKEN appears here once, for search assertions.

```python
# a fence that must not become a heading
def deploy(name):
    return f"deploying {name}"
```

## Appendix

Nothing to see here beyond the trailing section that makes the document long enough to scroll
past more than one viewport at typical terminal sizes.

# Separate school and kindergarten rules (0.2.0)

The existing primary school context, phone services, guardian IDs, enabled state,
history and per-user inbox are preserved. Additional children are configured only
in the existing local HA Store. No real family configuration is included here.

## Rules

- School children retain class/year/school relevance rules. SFO enrolment is not assumed.
- Kindergarten children are treated as attending their configured kindergarten now,
  even when Aula still displays an earlier enrolment. No start date is invented.
- With a meal plan, ordinary menus without a task or material change are silent.
  They never generate inferred packed-lunch, shopping or ingredient tasks.
- Explicit exceptions still count: packed lunch for an outing, own water bottle,
  food contributions for a named event. The meal plan does not override the source.
- Explicit requests to bring clothes, footwear, outing equipment or other items,
  consents, registrations, deadlines, closures and changed care times are extracted.
- Group membership is not invented. A concrete group task with an unknown child's
  group requires review rather than a confident instruction.
- Shared area sources may be considered even when another nursery publishes them;
  the prompt must distinguish area-wide information from another nursery's own plans.
- Food safety and changes to meal provision remain eligible for relevance assessment.

These are model instructions, not a claim that every future free-text source will
be classified perfectly. Synthetic tests verify routing, prompt content, persistence
and delivery boundaries. Actual model output needs a no-push live test after install.

## Configuration

`aula_bridge.analysis_child` accepts `child` with:

| Field | Meaning |
|---|---|
| `id` | Stable local identifier, distinct from `primary` |
| `child_name` | Parent-supplied name |
| `stage` | `school` or `kindergarten` |
| `institution_names` | Explicit full names; normalized exact matching, no broad substring |
| `institution_codes` | Verified routing codes only; may be empty |
| `profile_ids` | Child person-profile IDs as used by `regardingChildren[].profileId` |
| `shared_institution_names` | Explicit area-wide senders; not a blanket nursery allowlist |
| `meal_plan` | `true`, `false` or unknown (`null`) |
| `class_label`, `year_label`, `school_year` | Optional contextual text |

The action upserts only this child, does not enable analysis and does not start
model calls, push notifications or a replay. It preserves existing delivery settings.
Invalid configurations and attempts to overwrite `primary` are rejected. Failed
storage writes restore the preceding in-memory child configuration.

Verified child profile IDs also follow institution codes in the already-existing,
fresh coordinator profiles snapshot. This adds no polling or API calls. Stale or
unrecognized snapshots are not used to expand the scope. Snapshot institution names
never replace the parent's explicit current kindergarten context.

Legacy `analysis_control` configuration remains supported and preserves existing
additional children unless an explicit `additional_children` list is supplied.

## Deduplication and history

One source is fetched and analysed once for its matched family context, including
shared posts for both children. Original primary-only record keys remain compatible,
so adding a kindergarten child does not replay already-analysed school posts.
Additional-child record keys include the matched-context fingerprint. Changing a
child's rules can therefore reassess a recent source once; unchanged output retains
the existing duplicate-notification suppression. Older records and personal read/
archive marks are retained. A new record can become unread as with an ordinary revision.

The existing installation cutoff is retained. Recently skipped nursery sources after
that cutoff become eligible on the next scan. Older sources need an explicit test.

## Status and rollout

`analysis_status` now returns child rule summaries and each record's `child_ids`,
without returning phone destinations, guardian identifiers or credentials.

Install the reviewed 0.2.0 files under the existing `custom_components/aula_bridge/`:
`analysis.py`, `__init__.py`, `services.yaml`, `manifest.json`. Follow the existing
backup/config-check/restart workflow for Python integration changes. No automatic
installation, reload, restart, enablement or model call is performed by this commit.

After installation, upsert the actual local child context, read `analysis_status`,
and use `analysis_test` on a real nursery source to inspect the result without push.
Verify child-specific routing and a concrete bring-items request before relying on it.

Rollback: stop analysis, restore the four files from the base personal-inbox version
and reload the integration code through the normal restart workflow. The Store and
existing personal inbox remain intact; older code ignores additional-child settings.

## Validation

`python -m unittest discover -s ha-bridge/tests -p 'test_*.py' -v`

Includes exact institution routing, school versus nursery, fresh/stale profile-code
mapping, one job for shared posts, model-context minimization, meal-plan prompt rules,
legacy compatibility, save rollback, restart, tests without push, history and inbox.

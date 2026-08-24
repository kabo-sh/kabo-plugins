---
name: kabo-start
description: First-run onboarding — the kabo app's guided setup, replicated in Codex. A tap-through questionnaire (22 questions in 6 groups, all via request_user_input), one real analysis of the creator's own account, and a 90-day plan they commit to. Entered from $kabo-login step 3 or $analyze when no profile exists, or run explicitly with $kabo-start. Costs real analysis time and a meaningful share of the user's own quota (figures live in the Estimates block below) — never trigger it implicitly.
---

# Kabo Start — first-run onboarding

Give a newly signed-in creator the same guided first session as the kabo mobile app's onboarding: a short questionnaire, one real analysis of their own account, and a 90-day plan they commit to. The design intent is **faithful replication of the app flow** — same questions, same options, same order, same psychological beats — adapted only where the medium physically differs. Do not re-minimize it, do not skip questionnaire steps, do not rephrase questions.

This file is step-for-step the Codex counterpart of the Claude variant's `/kabo-start`. The **question set** (copy, options, order, groups) and the **profile schema** are shared with it and frozen in `tests/fixtures/onboarding-questions.json`; only three things differ here, and each is called out in the text: the data root, the entry point, and how a first sign-in is detected.

## Tone — how the whole flow speaks

These rules outrank everything below. The point of onboarding is that the creator feels accompanied, never pushed.

- **Every popup group opens with one short, warm line of context** (the `intro` line given with each group), never a bare run of questions.
- **Skip is honored silently.** If the user says *skip* or *later* at any point — in chat, or by submitting a popup with questions unanswered — move on with whatever exists. A skipped answer is **absent** from the profile (the key is omitted) — never an empty string, never a placeholder. Never ask again, never explain what they are missing, never re-pitch.
- **The waiting question (popup D) is asked once**, and whichever option they pick holds for the rest of the run. Do not reopen it.
- **Heartbeats during a silent wait** are at most one neutral progress line every ~3 minutes. Never "are you still there?", never a presence check, never a nudge.
- **Consent is one ask.** *Not now* is respected once and for all: no second ask, no reasons demanded, no cost comparison.
- **The pact popup (F) leads with the lighter option being completely fine.** No guilt, no "are you sure".
- **Source copy is English** (this file); render it in the user's language. The question text and options themselves stay verbatim — translate for display, never paraphrase.

## Data root and profile (differs from the Claude variant)

The profile is `<data root>/onboarding-profile.json`, where the data root is `$KABO_CODEX_DATA`, falling back to `~/.kabo/codex` — the same root `meta-guidance` and `$skill-runner` already use. It is **never** written directly under `~/.kabo/` (the Claude variant's root): both plugins can live on one machine, and writing into that root would overwrite the other plugin's profile with this one's (and vice versa). Write it mode 0600; create the data root with `umask 077` if it does not exist yet.

## When to run, and how a first sign-in is detected (differs from the Claude variant)

There is **no credentials file on Codex** — `$kabo-login` says so in its hard rules, and nothing here may look for one. The host holds the token. So "signed in" here means exactly what `$kabo-login` step 3 means: **the Kabo tools are in this task's tool list and a call does not answer 401.**

- `$kabo-login` step 3 just verified with a real call and the profile does not exist → first sign-in; `$kabo-login` hands off here. Start at step 1.
- `$analyze` was invoked with no arguments and the profile does not exist → hands off here.
- The user runs `$kabo-start` explicitly:
  - Kabo tools **not in this task's tool list** → reuse `$kabo-login` step 3's handling: the tool list is negotiated once at task start and does not refresh mid-task, so if they just authorized, that is not a failure — tell them to start a new task (or restart the session) and run `$kabo-start` there. If they have not authorized yet, point them to `$kabo-login`. **Do not** spawn a `codex exec` subprocess to check.
  - Tools visible but **401** → not authorized; point to `$kabo-login` and stop.
  - Tools work and **no profile** → start at step 1.
  - Profile exists with `onboarded_at` empty → an interrupted run. One popup (header `Welcome back`, question `You got to group {N} last time. Pick up where you left off?`, options `Continue` / `Start over`).
    - *Continue* → resume at the first group not in `completed_steps`, in flow order. If `provenance.run_id` and `baseline.measured_at` are set, the analysis already ran: do not run it again; go to delivery (step 11) once the remaining wait-phase groups their popup D choice allowed are done. If the run never completed, re-launch it — the consent popup (step 5) with its cost line is shown again, since it is a new spend.
    - *Start over* → discard the answers and begin at step 1. If `baseline.measured_at` is within 30 days, keep `baseline`, `diagnosis` and `provenance`, **skip steps 4–7** (channel, consent, launch, popup D) and go from group `baseline` straight to group `dream` — the consent popup is shown only when a new run will actually be launched. Otherwise step 4 onward runs as on a first pass.
  - Profile complete → welcome them back by handle, remind them of the plan (goal and cadence), and offer today's next step. Redoing onboarding is allowed on request; it overwrites questionnaire answers and the plan. If `baseline.measured_at` is within 30 days, the analysis is **not** re-run: steps 4–7 are skipped and group `baseline` leads straight into group `dream`. If it is older than 30 days, the consent popup (step 5) with its cost line is shown again; accepting re-runs the analysis, declining keeps the old baseline, says so in one line, and skips steps 6–7.

## Mechanics

- **Every popup is a `request_user_input` call.** Each question carries `id` (the fixture `key`), `header`, `question` (the fixture `text`, verbatim), and `options` as `{label, description}` with the fixture labels verbatim. See "Tool contract" at the end for what is verified about the tool and how to degrade.
- The group `intro` line goes in chat **immediately before** the call, prefixed with the group's stepper label where it has one (`Step N of 6`).
- Free-text input (the channel link) is asked in chat, not in a popup.
- After **every** popup group is answered, write the profile with what exists so far and append the group name to `completed_steps` (this is what makes resume possible; a flow this long gets interrupted).
- If `request_user_input` is unavailable in this mode (it is not offered in non-interactive `codex exec`), ask the same questions one group at a time in chat — same copy, same options, numbered — and accept a number or the option text.

## Estimates — the single source for time and cost figures

- `{analysis_minutes}` = **10–15** · `{token_estimate}` = **on the order of 100,000 tokens**
- Measured once (2026-08-20 rehearsal: 12m20s, ~109k tokens on one small account); figures vary with account size and will change as the runner improves. Update them from telemetry **here, and only here** — every `{analysis_minutes}` / `{token_estimate}` below substitutes these values at run time. Never hardcode figures into the copy.

## Flow

### 1. Welcome (chat)

> Unleash your potential to go viral with AI. Your content deserves to be seen.
>
> Here's the plan: **6 groups of quick questions (about 4 minutes), one real analysis of your account, and a 90-day plan.**
> Say **skip** at any point and I'll continue with whatever you've answered so far.

(The welcome sells the plan, not the price — the analysis cost belongs to the consent popup in step 5, where agreeing to it is the point. Decided 2026-08-22 after review discussion.)

### 2. Group `basics` — creator basics (one call, 4 questions) · `Step 1 of 6`

Intro: *First, a quick picture of where you are today. Four taps.*

| id | header | question | options |
|---|---|---|---|
| `creating` | Experience | How long have you been creating content? | Less than a month / 1–3 months / 3–12 months / More than a year |
| `posting` | Posting | How many times do you post per week? | Not every week / Once or twice / 3–5 times / Every day |
| `platforms` | Platforms | On how many platforms do you post? | One platform / Two platforms / Three platforms / Four or more |
| `goal` | Goal | What is your main goal? | Grow my audience / Make more money / Build my brand / Go viral |

### 3. Group `baseline` — starting line (one call, 4 questions) · `Step 2 of 6`

Intro: *Now your starting line, so the plan is measured against you and nobody else.*

Before the call, infer `{country}` from the shell time zone (`echo $TZ`, falling back to `date +%Z`; map the zone to its most likely country). If no country can be defended, substitute the zone name itself for `{country}` and keep the question text unchanged — never a guess presented as fact. "No — I'll type it" is answered through the free-text entry; take whatever they type as the country. If nothing was typed, leave it absent — do not ask again in chat.

| id | header | question | options |
|---|---|---|---|
| `followers_now` | Followers | How many followers do you have right now? | 0–1K / 1K–10K / 10K–250K / 250K+ |
| `country` | Region | You look like you're creating from {country}. Right? | Yes, that's right / No — I'll type it |
| `account_type` | Account type | Is this account personal or business? | Personal brand / A business or product / Client work / Not sure yet |
| `referral` | Referral | How did you hear about Kabo? | Someone on the team / GitHub or the docs / A friend / Somewhere else |

`followers_now` is where they are; `followers_dream` (group `commitment`) is where they dream of being — two different fields, never merged. For `country`, the free-text entry is the tool's own notes field (see Tool contract).

### 4. Channel (chat)

> Ready for your diagnosis? Send your channel link or handle — YouTube or Instagram. Public data only: no login, no account connection.

Error branches — never a dead end, never silent:

- **Platform not recognisable** → say you only read YouTube and Instagram, show one example of each format, ask them to resend.
- **A single-video link** → say it is one video, not a channel, and ask for the channel or profile link. Do not guess the account from it.
- **Private account / no public data** → say plainly that the public data cannot be fetched, then take the Not-now branch (step 5) for the rest of the run. Do not retry.
- **Account not found** → report what actually came back and ask them to check the spelling. **At most two retries**; after the second failure, take the Not-now branch.

### 5. Group `consent` — consent + run confirmation (one call, 1 question)

Intro: *Before anything runs: this is your account and your quota, so it is your call.*

Before showing it, resolve the account-review skill via `registry_skill_search` (capability keywords, per `meta-guidance`) and put the matched skill's name / version / permissions into the option descriptions — this popup **doubles as the pre-run confirmation meta-guidance requires**. The description of *Yes, analyze it* **must** also carry: *Takes about {analysis_minutes} minutes and spends roughly {token_estimate} of your own quota* (values from the Estimates block). The cost is a condition of consent, not a footnote.

| id | header | question | options |
|---|---|---|---|
| `consent` | Consent | Do you own this account and agree to let Kabo analyze its public data? | Yes, analyze it / Not now |

- **Yes** → step 6.
- **Not now** → no run, no second ask, no reasons requested. Skip popup D (there is nothing to wait for) and the `style` bonus round (not offered on this path). Say one line first, so they know how much is left and that they can stop:

  > No problem. A few more questions would help shape your plan — about two minutes. Say **skip** at any point and we'll go straight to the plan.

  Then offer `dream`, `niche_area`, `niche_sub`, `commitment` in sequence (steps 8–10, without `style`), each saved as it completes. On this path, **skip said once ends the questionnaire** — not just the current group — and the flow goes straight to step 11. Step 11 then takes its Not-now form and the pact anchors on cadence only.

### 6. Launch the real analysis

Follow `meta-guidance`'s single-skill flow exactly (cache check → download → `skill-verify` → dispatch `$skill-runner` in a Codex subagent with Section C attached). Launch it **in the background** if the environment allows and continue to step 7 while it works; if backgrounding is not possible, ask popup D anyway but with its **foreground intro** instead of the background one, run the groups it selects first, then run the analysis, and keep the heartbeat rules during the run. In the foreground case, *Nothing — ping me when it's done* means the run starts straight away. On launch, in chat:

> Analyzing your account — this is a real run over your actual videos, so it takes a few minutes.

### 7. Group `wait` — popup D, how to wait (one call, 1 question) · `Step 3 of 6`

Intro: *The analysis is running in the background. Whatever you pick here is fine, and I'll stick to it.*

Foreground intro (only when the runner could not be backgrounded, step 6): *The analysis will run next and takes about {analysis_minutes} minutes. Anything you'd like to answer first? Whatever you pick is fine — "Nothing" starts the run straight away.*

| id | header | question | options |
|---|---|---|---|
| `wait_preference` | Waiting | The analysis takes about {analysis_minutes} minutes. How do you want to spend it? | Keep answering questions / Just the essentials, then leave me alone / Nothing — ping me when it's done |

Asked **once**; the answer holds for the rest of the run.

- **Keep answering questions** → groups `dream`, `niche_area`, `niche_sub`, `commitment`, `style` (steps 8–10), then the silent wait.
- **Just the essentials, then leave me alone** → `dream`, `niche_area`, `niche_sub` only, then the silent wait. `commitment` and `style` are not asked, not mentioned.
- **Nothing — ping me when it's done** → write the partial profile, then the silent wait. At delivery, the first line is an explicit recall (*Your analysis is done — here it is.*), never the report straight away.

**The silent wait**: at most one line every ~3 minutes, fixed form: `Still analyzing — {connector calls completed} done, about {N} minutes left.` Nothing else — no filler, no extra questions, no presence checks. If the user speaks, answer them; do not take it as an invitation to resume the questionnaire unless they ask.

### 8. Group `dream` — dream and character (one call, 4 questions) · `Step 4 of 6`

Intro: *While it works, a little about what you're really after. There are no wrong answers here.*

| id | header | question | options |
|---|---|---|---|
| `dream` | Dream | What is your ultimate dream? | Build a massive audience / Make content my full-time job / Help people with my story / Leave a legacy |
| `obstacle` | Obstacle | What prevents you from achieving this dream? | I don't know what to post / I struggle with consistency / I need better feedback / I compare myself to others |
| `personality` | Personality | Are you more of an introvert or an extrovert? | Introvert / Extrovert / A bit of both |
| `belief` | Self-doubt | When a video doesn't work, I tend to doubt myself. | Not really me / Sometimes / Often / Totally me |

### 9. Groups `niche_area` + `niche_sub` — niche, two levels (two calls, 1 question each) · `Step 5 of 6`

**A free-text entry must always be available on both of these.** This is the one hard warning the product spec carries (a closed niche list is a complaint that went unfixed elsewhere for five years). See Tool contract: if you are not certain the host is adding its own free-text entry, add an explicit `Something else` option and ask for the text in chat.

Intro (before B1): *Your niche, in two taps. If none of these fit, just type your own.*

| id | header | question | options |
|---|---|---|---|
| `niche_area` | Niche | What's your main content area? | Lifestyle & personal / Knowledge & skills / Entertainment & creative / Business & professional |

Intro (before B2): *And one level down.*

| id | header | question | options (by `niche_area` answer) |
|---|---|---|---|
| `niche_sub` | Sub-niche | Which of these is closest? | see below |

| `niche_area` | `niche_sub` options |
|---|---|
| Lifestyle & personal | Fitness & health / Food & cooking / Travel / Fashion & beauty |
| Knowledge & skills | Tech & coding / Finance & investing / Education & how-to / Language & culture |
| Entertainment & creative | Comedy & skits / Gaming / Music & dance / Art & design |
| Business & professional | Marketing & growth / Entrepreneurship / Real estate / Career & productivity |

If `niche_area` came in as free text, ask `niche_sub` with the same question, no preset list, and the free-text entry only. If `niche_area` was skipped, skip `niche_sub` too without comment.

### 10. Groups `commitment` + `style` — plan inputs, then a bonus round · `Step 6 of 6`

Intro (before `commitment`): *Last group: the inputs for your plan. Answer as you are, not as you think you should be.*

| id | header | question | options |
|---|---|---|---|
| `grit` | Grit | I'm the type to keep going even when it's hard. | Not really me / Sometimes / Often / Totally me |
| `time` | Time | How much time are you ready to invest? | 15 minutes a day / 30 minutes a day / 1 hour a day / As much as it takes |
| `followers_dream` | Dream number | What follower count are you dreaming of? | 1,000 / 10,000 / 100,000 / 1,000,000+ |
| `collabs` | Brand deals | Would you be open to paid brand collaborations? | Yes / Maybe later / No |

Intro (before `style`, one call, 4 questions, no stepper label — it is a bonus, not a seventh step): *Bonus round, only if you feel like it: how your videos are made. Skip any of these freely.*

| id | header | question | options |
|---|---|---|---|
| `hook_style` | Hook style | How do most of your videos start? | A question / A bold claim / A story / No fixed pattern |
| `scripting` | Scripting | Do you script before filming? | Full script / Bullet points / I improvise / Depends |
| `on_camera` | On camera | Are you on camera? | Always / Sometimes / Voice only / Never |
| `video_length` | Length | How long are your videos usually? | Under 30s / 30–60s / 1–3 min / Over 3 min |

Then, if the run is still going, the silent wait from step 7 — one neutral line per ~3 minutes, nothing more.

### 11. Deliver the result (chat; when the runner returns)

If the user chose *Nothing — ping me when it's done*, open with the explicit recall line. Then deliver per `meta-guidance` Section E — the runner's `creator_report` is the body — wrapped in the app's beats:

1. **Real profile card first**: handle, followers, videos analyzed, median views. Real numbers before any judgment.
2. **The report**: niche, summary, strengths, weaknesses — whatever the skill produced, baseline numbers kept.
3. **The app's two beats, grounded in the report**:
   - *"Your account has potential."* — name the strongest real signal (e.g. their breakout video and its multiple over their own median).
   - *"But right now, you're missing the method."* — name the report's biggest actual gap. No invented scores.
4. **Future view, anchored to their own data**:
   > Your best video already hit {X} — {N}× your median. The plan is to make that your baseline, not your outlier.
5. **Niche cross-check** (only if a stated niche exists and the report produced one): one line,
   > The report reads your niche as {inferred}; you described it as {stated}.
   If they match, save and move on. If they differ, do not silently pick either — step 12. The saving rule for every outcome is in step 12.

If the run failed or came back partial: say what is missing in task terms, deliver what exists, and keep going — the plan then anchors on cadence. Never fabricate a baseline, never leave a dead end.

**Not-now form** (consent declined, private account, or account not found): this step is **not skipped**. Say plainly that without real data there is no diagnosis; what you can offer is direction based on their answers (goal, obstacle, niche, time) — a few concrete lines, no numbers — and that sending a link any time later gets them the full check-up. Then continue to step 13.

### 12. Group `niche_reconcile` — popup E (one call, 1 question; only when inferred ≠ stated)

Intro: *One thing to settle: the report and your own answer see your niche a bit differently. Either is a fine choice.*

| id | header | question | options |
|---|---|---|---|
| `niche_reconcile` | Your niche | Your account reads as {inferred}, but you said {stated}. Which should I save? | Use {inferred} / Keep {stated} / They're both partly right |

Niche rule (identical in both plugins). *Stated* is `niche_sub` if answered, otherwise `niche_area`; *inferred* is the niche the report produced. If the report produced no niche, save nothing here. If no stated niche exists (skipped, or the group was never offered) → `diagnosis.niche` = inferred, `niche_source = "inferred"`, no question. If stated and inferred agree → `diagnosis.niche` = stated, `niche_source = "stated"`, no question. If they differ → Popup E: **Use {inferred}** → `diagnosis.niche` = inferred, `niche_source = "inferred"`; **Keep {stated}** → `diagnosis.niche` = stated, `niche_source = "stated"`; **They're both partly right** → `diagnosis.niche` = `"{stated} / {inferred}"`, `niche_source = "reconciled"`; Popup E skipped → `diagnosis.niche` = stated, `niche_source = "stated"`. `diagnosis.summary` is never edited to hold the other value. Append `"niche_reconcile"`.

### 13. The 90-day pact (chat card, then popup F)

Compute: cadence **N** from the posting + time answers (at least their current frequency, at most what their time budget supports; if either was skipped, use what is there, and if both were skipped, N = 2). The measurable target lifts their **median** toward the level their own top content already reached. Render:

> **Your 90-day plan** — until {date +90 days}
> Goal: lift your median views from {X} toward {Y} — the level your own best content already proves possible
> Cadence: {N} posts per week
> First experiment: {the report's top recommendation}
>
> *"I commit to posting {N} times per week, to grow my channel."*
>
> On {date} we re-measure with the same yardstick.

The `followers_dream` answer is their dream number — acknowledge it as the dream, but the measurable goal stays anchored to their own baseline. In the Not-now form the goal line is omitted and the card anchors on cadence only.

Then **group `pact`** — popup F (one call, 1 question). The card alone is a statement; the pact is an action the user takes.

Intro: *Here's the plan as it stands. A lighter version is completely fine; the one you'll actually keep is the right one.*

| id | header | question | options |
|---|---|---|---|
| `pact` | The pact | Commit to {N} posts a week until {date}? | I commit / Make it lighter / Make it harder / Not now |

- **I commit** → `plan.committed = true`, `committed_at` = now.
- **Make it lighter** → N − 1 (minimum 1); **Make it harder** → N + 1. Re-render the card once with the new N and ask popup F once more, same intro. If the second answer is again lighter or harder, apply it, re-render the card, and save that plan with `committed = false` — a plan they shaped is the outcome; there is no third popup and no pledge is extracted.
- **Not now** → `plan.committed = false`. Save the plan as it stands. No follow-up, no reasons asked; the close (step 14) is the same warm close.

### 14. Save + close

Write `<data root>/onboarding-profile.json` (mode 0600) in full:

```json
{
  "schema_version": "kabo-onboarding-profile.v1",

  "handle": "", "platform": "youtube|instagram",

  "answers": {
    "creating": "", "posting": "", "platforms": "", "goal": "",
    "dream": "", "obstacle": "", "personality": "", "belief": "", "grit": "",
    "time": "", "followers_dream": "", "collabs": "",

    "followers_now": "",
    "country": "",
    "account_type": "",
    "referral": "",
    "niche_area": "", "niche_sub": "",
    "hook_style": "", "scripting": "", "on_camera": "", "video_length": ""
  },

  "diagnosis": {
    "niche": "", "niche_source": "inferred|stated|reconciled",
    "summary": "",
    "strengths": [], "weaknesses": [],
    "hashtags": []
  },

  "baseline": {
    "median_views": 0,
    "engagement_rate": 0,
    "breakout": { "url": "", "views": 0, "multiple": 0 },
    "measured_at": "",
    "coverage": { "posts_analyzed": 0, "posts_total": 0, "earliest_covered": "", "limitations": [] }
  },

  "plan": {
    "target_median": 0, "cadence_per_week": 0,
    "first_experiment": "", "start": "", "review": "",
    "committed": false, "committed_at": ""
  },

  "provenance": { "run_id": "", "skill_id": "", "skill_version": "" },

  "onboarded_at": "", "completed_steps": []
}
```

- `answers.*`: the option text as chosen (or the free text). A skipped answer is **absent** from the profile (the key is omitted) — never an empty string, never a placeholder.
- `diagnosis`, `baseline`, `provenance`: from the run, as produced; `coverage.limitations` carries the run's stated limitations verbatim so a later re-measure has the same yardstick. On the Not-now path there was no run, so all three blocks are **omitted** (not written as empty / zero).
- `onboarded_at`: set only here, at the close; its presence is what marks a finished run.

Close in chat:

> That's your setup done. Two things I can do whenever you're ready:
> - before you post, send me the video — I'll check it against your own baseline;
> - say **trends** and I'll show you what's working in your niche right now.
>
> Saved to `{profile path}` — your answers, your baseline, and this plan. No credentials in it. Delete the file any time and I'll start over.

In later sessions, read this profile and greet returning creators from it instead of re-asking anything.

## App steps deliberately not carried over

- **notify** (push-notification permission): no medium equivalent; the return-visit close in step 14 carries that function.
- **intro carousel** ("250,000 accounts analyzed"): fabricated social proof — fails the evidence rules.
- **save / Apple / Google sign-in**: `$kabo-login` already happened; the profile file is the save.
- **free-tier blurred report + paywall**: this is an internal alpha plugin and does not charge; the full report is delivered. This is a deliberate deviation from the product spec's principle 1, recorded here so nobody mistakes it for an oversight.

## Tool contract — `request_user_input` (what is verified, what is assumed)

Verified against the Codex binary and real session logs (2026-08):

- The call takes `questions` (an array), each with `id`, `header`, `question`, `options: [{label, description}]`, optional `is_secret`. Optional top-level `is_blocking` / `auto_resolution_ms` exist; do not set them here — every popup blocks.
- **Several questions per call are supported**: the tool describes itself as "one to three short questions", and a real call with 2 questions answered in one result exists. **Three is the documented ceiling.** The 4-question groups above (`basics`, `baseline`, `dream`, `commitment`, `style`) therefore go out as **two calls: 3 questions + 1 question**, under the same stepper label and a single intro line. Do not re-announce the step between the two calls.
- The result is `{"answers": {"<id>": {"answers": ["<label>", ...]}}}`. Unanswered questions are absent from the map — treat absence as a skip, silently.
- **Free text is automatic in the interactive TUI**: the host appends a "None of the above" choice to every question and offers a notes field; typed text comes back as an extra array element prefixed `user_note: `. So **do not add your own "Other" option** where that is the surface; strip the `user_note: ` prefix when saving.
- Availability: interactive / collaborative modes only. It is **not offered in `codex exec`** and needs an interactive terminal — fall back to chat there (see Mechanics).

Assumed, and therefore handled defensively (a later maintainer with the schema in hand can tighten these):

- **Whether every surface adds the free-text entry** is not confirmed outside the TUI. On `niche_area` and `niche_sub` — the two questions where a closed list is unacceptable — if you cannot see that the host is adding its own free-text entry, **add an explicit `Something else` option** and, when chosen, ask for the text in one chat line. The same applies to `country`'s *No — I'll type it*.
- **Option count limits** are not documented. Every group above uses at most four options, and a real call has used three; if a call is rejected for option count, do not trim options — report it, since the two plugins' option sets must stay byte-identical.
- **If a multi-question payload is rejected**, fall back to **one question per call**. In that case the stepper label switches to `Question N of 22` (counting only the 22 questionnaire questions, in fixture order; consent, wait, reconcile and pact carry no label) and the "6 groups" wording in the welcome becomes "22 quick questions" — the user must never hear one counting scheme and see another.
- Multi-select is not used anywhere in this flow, so its availability does not matter.

## Hard rules

- Question copy and options are fixed — replicate, don't improvise. They are frozen in `tests/fixtures/onboarding-questions.json`.
- **Never invent numbers**: no fake scores, no invented social proof, no follower projections. Every figure comes from the run or is absent.
- The skill run itself follows `meta-guidance` unchanged (verification, Section E delivery, failure semantics). Onboarding changes the framing around the run, never the evidence rules.
- Never promise virality; the pact's measurable target derives from the creator's own history only.
- Never look for, read, or write a credentials file or token; none exists on this machine.
- Never write the profile anywhere but `<data root>/onboarding-profile.json`.

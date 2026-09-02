---
name: kabo-start
description: First-run onboarding — the kabo app's guided setup, replicated in Codex. A tap-through questionnaire (12 questions in 3 groups, all via request_user_input), one real analysis of the creator's own account, a 90-day plan with named weekly slots they commit to, and the first piece of content that fills the first slot. Entered from $kabo-login step 3 or $analyze when no profile exists, or run explicitly with $kabo-start. Costs real analysis time and a meaningful share of the user's own quota (figures live in the Estimates block below) — never trigger it implicitly.
---

# Kabo Start — first-run onboarding

Give a newly signed-in creator a guided first session: a short questionnaire, one real analysis of their own account, a 90-day plan with named weekly slots they commit to, and then the first piece of content that fills the first slot. The flow keeps the kabo mobile app's psychological beats — a real diagnosis before any advice, a plan measured against their own history, a pact they tap rather than read — but it is deliberately **shorter than the app's questionnaire** and it does not stop at the plan. Do not re-expand it, do not add questions back, do not rephrase the ones that are here.

This file is step-for-step the Codex counterpart of the Claude variant's `/kabo-start`. The **question set** (copy, options, order, groups) and the **profile schema** are shared with it and written out in full below — read them from this file. A regression test in the source repo holds the two variants in step. Only three things differ here, and each is called out in the text: the data root, the entry point, and how a first sign-in is detected.

**12 questionnaire questions in 3 groups.** Everything the app asked that did not change an output was cut (2026-08-26): the dream-and-character group, the video-style bonus round, the grit statement, the brand-collaboration question, and popup D, which asked how the creator wanted to spend the wait. The two niche levels and the plan inputs are now one step. Cutting them cost nothing downstream — none of them fed the diagnosis, the cadence, or the plan.

## Tone — how the whole flow speaks

These rules outrank everything below. The point of onboarding is that the creator feels accompanied, never pushed.

- **Every popup group opens with one short, warm line of context** (the `intro` line given with each group), never a bare run of questions.
- **Skip is honored silently.** If the user says *skip* or *later* at any point — in chat, or by submitting a popup with questions unanswered — move on with whatever exists. A skipped answer is **absent** from the profile (the key is omitted) — never an empty string, never a placeholder. Never ask again, never explain what they are missing, never re-pitch.
- **There is no question about how to wait.** The one wait-phase group is offered once, plainly, while the run works; *skip* ends it. After it, the wait is silent.
- **Heartbeats during a silent wait** are at most one neutral progress line every ~3 minutes. Never "are you still there?", never a presence check, never a nudge.
- **Consent is one ask.** *Not now* is respected once and for all: no second ask, no reasons demanded, no cost comparison. Every popup that precedes a run carries that run's cost line.
- **The pact popup (F) leads with the lighter option being completely fine**, and is settled in a single reply — a lighter or harder cadence is applied and saved on the spot, never bounced back for a second confirmation. No guilt, no "are you sure".
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
    - *Continue* → resume at the first group not in `completed_steps`, in flow order. If `provenance.run_id` and `baseline.measured_at` are set, the analysis already ran: do not run it again; go to delivery (step 9) once step 7 is done. If the run never completed, re-launch it — the consent popup (step 5) with its cost line is shown again, since it is a new spend.
    - *Start over* → discard the answers and begin at step 1. If `baseline.measured_at` is within 30 days, keep `baseline`, `diagnosis` and `provenance`, **skip steps 4–6** (channel, consent, launch) and go from group `baseline` straight to group `plan_inputs` — the consent popup is shown only when a new run will actually be launched. Otherwise step 4 onward runs as on a first pass.
  - Profile complete → welcome them back by handle, remind them of the plan (goal and cadence), and offer today's next step. If `first_move` is absent, step 12 is that next step; offer it rather than redoing the questionnaire. Redoing onboarding is allowed on request; it overwrites questionnaire answers and the plan. If `baseline.measured_at` is within 30 days, the analysis is **not** re-run: steps 4–6 are skipped and group `baseline` leads straight into group `plan_inputs`. If it is older than 30 days, the consent popup (step 5) with its cost line is shown again; accepting re-runs the analysis, declining keeps the old baseline, says so in one line, and skips step 6.
- `completed_steps` from a superseded version of this flow (`wait`, `dream`, `niche_area`, `commitment`, `style`) may appear in an older profile; treat them as satisfied where they overlap and ignore the rest, rather than restarting the creator.

## Mechanics

- **Every popup is a `request_user_input` call.** Each question carries `id` (the fixture `key`), `header`, `question` (the fixture `text`, verbatim), and `options` as `{label, description}` with the fixture labels verbatim. See "Tool contract" at the end for what is verified about the tool and how to degrade.
- The group `intro` line goes in chat **immediately before** the call, prefixed with the group's stepper label where it has one (`Step N of 3`).
- Free-text input (the channel link, and the handle or URL in step 12) is asked in chat, not in a popup.
- After **every** popup group is answered, write the profile with what exists so far and append the group name to `completed_steps` (this is what makes resume possible; the flow still spans a multi-minute run).
- If `request_user_input` is unavailable, ask the same questions one group at a time in chat — same copy, same options, numbered — and accept a number or the option text. See "Tool contract" below for why this is common, not exceptional.

## Estimates — the single source for time and cost figures

- `{questionnaire_minutes}` = **about a minute** — basis: the 2026-08-20 rehearsal measured ~2 minutes for the then-22-question set; 12 questions scale to about half of that. This is a scaled figure, not a fresh measurement; re-measure and correct it here.
- `{analysis_minutes}` = **10–15** · `{token_estimate}` = **on the order of 100,000 tokens** — measured once (2026-08-20 rehearsal: 12m20s, ~109k tokens on one small account); figures vary with account size and will change as the runner improves.
- `{content_minutes}` and `{content_token_estimate}` for the step-12 run are **not measured yet**. Until a rehearsal produces them, say plainly that this second run spends a further share of their quota and that its size has not been measured — **never quote a number for it**. Inventing one to fill the sentence breaks the evidence rules as surely as inventing a follower count.
- Update all of these from telemetry **here, and only here** — every `{...}` below substitutes these values at run time. Never hardcode figures into the copy.

## Flow

### 1. Welcome (chat)

> Unleash your potential to go viral with AI. Your content deserves to be seen.
>
> Here's the plan: **3 groups of quick questions ({questionnaire_minutes}), one real analysis of your account, a 90-day plan — and then we write your first piece of content together.**
> Say **skip** at any point and I'll continue with whatever you've answered so far.

(The welcome sells the plan, not the price — the analysis cost belongs to the consent popup in step 5, where agreeing to it is the point. Decided 2026-08-22 after review discussion.)

### 2. Group `basics` — creator basics (4 questions) · `Step 1 of 3`

Intro: *First, a quick picture of where you are today. Four taps.*

| id | header | question | options |
|---|---|---|---|
| `creating` | Experience | How long have you been creating content? | Less than a month / 1–3 months / 3–12 months / More than a year |
| `posting` | Posting | How many times do you post per week? | Not every week / Once or twice / 3–5 times / Every day |
| `platforms` | Platforms | On how many platforms do you post? | One platform / Two platforms / Three platforms / Four or more |
| `goal` | Goal | What is your main goal? | Grow my audience / Make more money / Build my brand / Go viral |

### 3. Group `baseline` — starting line (4 questions) · `Step 2 of 3`

Intro: *Now your starting line, so the plan is measured against you and nobody else.*

Before the call, infer `{country}` from the shell time zone (`echo $TZ`, falling back to `date +%Z`; map the zone to its most likely country). If no country can be defended, substitute the zone name itself for `{country}` and keep the question text unchanged — never a guess presented as fact. "No — I'll type it" is answered through the free-text entry; take whatever they type as the country. If nothing was typed, leave it absent — do not ask again in chat.

| id | header | question | options |
|---|---|---|---|
| `followers_now` | Followers | How many followers do you have right now? | 0–1K / 1K–10K / 10K–250K / 250K+ |
| `country` | Region | You look like you're creating from {country}. Right? | Yes, that's right / No — I'll type it |
| `account_type` | Account type | Is this account personal or business? | Personal brand / A business or product / Client work / Not sure yet |
| `referral` | Referral | How did you hear about Kabo? | Someone on the team / GitHub or the docs / A friend / Somewhere else |

`followers_now` is where they are; `followers_dream` (group `plan_inputs`) is where they dream of being — two different fields, never merged. For `country`, the free-text entry is the tool's own notes field (see Tool contract).

### 4. Channel (chat)

> Ready for your diagnosis? Send your channel link or handle — YouTube or Instagram. Public data only: no login, no account connection.

Error branches — never a dead end, never silent:

- **Platform not recognisable** → say you only read YouTube and Instagram, show one example of each format, ask them to resend.
- **A single-video link** → say it is one video, not a channel, and ask for the channel or profile link. Do not guess the account from it.
- **Private account / no public data** → say plainly that the public data cannot be fetched, then take the Not-now branch (step 5) for the rest of the run. Do not retry.
- **Account not found** → report what actually came back and ask them to check the spelling. **At most two retries**; after the second failure, take the Not-now branch.

### 5. Group `consent` — consent + run confirmation (1 question)

Intro: *Before anything runs: this is your account and your quota, so it is your call.*

Before showing it, resolve the account-review skill via `registry_skill_search` (capability keywords, per `meta-guidance`) and put the matched skill's name / version / permissions into the option descriptions — this popup **doubles as the pre-run confirmation meta-guidance requires**. The description of *Yes, analyze it* **must** also carry: *Takes about {analysis_minutes} minutes and spends roughly {token_estimate} of your own quota* (values from the Estimates block). The cost is a condition of consent, not a footnote.

| id | header | question | options |
|---|---|---|---|
| `consent` | Consent | Do you own this account and agree to let Kabo analyze its public data? | Yes, analyze it / Not now |

- **Yes** → step 6.
- **Not now** → no run, no second ask, no reasons requested. Skip step 8 (there is nothing to wait for); step 9 is **not** skipped — it takes its Not-now form, below. Say one line first, so they know how much is left and that they can stop:

  > No problem. One more short group would help shape your plan. Say **skip** and we'll go straight to it.

  Then offer group `plan_inputs` and group `niche_sub` (step 7), each saved as it completes. On this path, **skip said once ends the questionnaire** — not just the current group — and the flow goes straight to step 9's Not-now form, then to step 11, where the pact anchors on cadence only. Step 12 still runs; it does not depend on the account analysis.

### 6. Launch the real analysis

Follow `meta-guidance`'s single-skill flow exactly (cache check → download → `skill-verify` → dispatch `$skill-runner` in a Codex subagent with Section C attached). Launch it **in the background** if the environment allows and continue to step 7 while it works. If backgrounding is not possible, say so in one line, ask step 7 first so the questions are out of the way, then run the analysis, keeping the heartbeat rules during the run.

There is no longer a popup asking how the creator wants to spend the wait. With one short group left it cost more attention than it saved, and it routinely bought silence the creator had not asked for. The group in step 7 is offered once, plainly, and *skip* ends it — that is the whole consent mechanism now.

On launch, in chat:

> Analyzing your account — this is a real run over your actual videos, so it takes a few minutes.

Record `provenance.run_id`, `skill_id` and `skill_version` in the profile as soon as they are known.

### 7. Groups `plan_inputs` + `niche_sub` — plan inputs and niche · `Step 3 of 3`

Intro (before `plan_inputs`): *Last step, while the analysis works: the two inputs your plan needs, and your niche.*

| id | header | question | options |
|---|---|---|---|
| `time` | Time | How much time are you ready to invest? | 15 minutes a day / 30 minutes a day / 1 hour a day / As much as it takes |
| `followers_dream` | Dream number | What follower count are you dreaming of? | 1,000 / 10,000 / 100,000 / 1,000,000+ |
| `niche_area` | Niche | What's your main content area? | Lifestyle & personal / Knowledge & skills / Entertainment & creative / Business & professional |

Three questions is exactly the documented ceiling for one `request_user_input` call, so this group goes out as a single call.

Intro (before `niche_sub`): *And one level down.*

| id | header | question | options (by `niche_area` answer) |
|---|---|---|---|
| `niche_sub` | Sub-niche | Which of these is closest? | see below |

| `niche_area` | `niche_sub` options |
|---|---|
| Lifestyle & personal | Fitness & health / Food & cooking / Travel / Fashion & beauty |
| Knowledge & skills | Tech & coding / Finance & investing / Education & how-to / Language & culture |
| Entertainment & creative | Comedy & skits / Gaming / Music & dance / Art & design |
| Business & professional | Marketing & growth / Entrepreneurship / Real estate / Career & productivity |

**A free-text entry must always be available on both niche questions.** This is the one hard warning the product spec carries (a closed niche list is a complaint that went unfixed elsewhere for five years). See Tool contract: if you are not certain the host is adding its own free-text entry, add an explicit `Something else` option and ask for the text in chat.

If `niche_area` came in as free text, ask `niche_sub` with the same question, no preset list, and the free-text entry only. If `niche_area` was skipped, skip `niche_sub` too without comment.

### 8. The silent wait (chat; only while the runner is still working)

The questionnaire now covers about a minute of a run that takes {analysis_minutes}. That gap is not filled with more questions. When step 7 is done and the runner is still working, say once:

> That's all the questions. The analysis is still running — I'll deliver it here the moment it's back. Your answers so far are saved, so you can step away.

Then at most one line every ~3 minutes, fixed form: `Still analyzing — {connector calls completed} done, about {N} minutes left.` Nothing else — no filler, no extra questions, no presence checks. If the user speaks, answer them; do not take it as an invitation to resume the questionnaire unless they ask.

### 9. Deliver the result (chat; when the runner returns)

If the creator has been silent through a long wait, open with an explicit recall line (*Your analysis is done — here it is.*) before anything else. Then deliver per `meta-guidance` Section E — the runner's `creator_report` is the body — wrapped in the app's beats:

1. **Real profile card first**: handle, followers, videos analyzed, median views. Real numbers before any judgment.
2. **The report**: niche, summary, strengths, weaknesses — whatever the skill produced, baseline numbers kept.
3. **The app's two beats, grounded in the report**:
   - *"Your account has potential."* — name the strongest real signal (e.g. their breakout video and its multiple over their own median).
   - *"But right now, you're missing the method."* — name the report's biggest actual gap. No invented scores.
4. **Future view, anchored to their own data**:
   > Your best video already hit {X} — {N}× your median. The plan is to make that your baseline, not your outlier.
5. **Niche cross-check** (only if a stated niche exists and the report produced one): one line,
   > The report reads your niche as {inferred}; you described it as {stated}.
   If they match, save and move on. If they differ, do not silently pick either — step 10. The saving rule for every outcome is in step 10.

If the run failed or came back partial: say what is missing in task terms, deliver what exists, and keep going — the plan then anchors on cadence. Never fabricate a baseline, never leave a dead end.

**Not-now form** (consent declined, private account, or account not found): this step is **not skipped**. Say plainly that without real data there is no diagnosis; what you can offer is direction based on their answers (goal, niche, time) — a few concrete lines, no numbers — and that sending a link any time later gets them the full check-up. Then continue to step 11.

### 10. Group `niche_reconcile` — popup E (1 question; only when inferred ≠ stated)

Intro: *One thing to settle: the report and your own answer see your niche a bit differently. Either is a fine choice.*

| id | header | question | options |
|---|---|---|---|
| `niche_reconcile` | Your niche | Your account reads as {inferred}, but you said {stated}. Which should I save? | Use {inferred} / Keep {stated} / They're both partly right |

Niche rule (identical in both plugins). *Stated* is `niche_sub` if answered, otherwise `niche_area`; *inferred* is the niche the report produced. If the report produced no niche, save nothing here. If no stated niche exists (skipped, or the group was never offered) → `diagnosis.niche` = inferred, `niche_source = "inferred"`, no question. If stated and inferred agree → `diagnosis.niche` = stated, `niche_source = "stated"`, no question. If they differ → Popup E: **Use {inferred}** → `diagnosis.niche` = inferred, `niche_source = "inferred"`; **Keep {stated}** → `diagnosis.niche` = stated, `niche_source = "stated"`; **They're both partly right** → `diagnosis.niche` = `"{stated} / {inferred}"`, `niche_source = "reconciled"`; Popup E skipped → `diagnosis.niche` = stated, `niche_source = "stated"`. `diagnosis.summary` is never edited to hold the other value. Append `"niche_reconcile"`.

### 11. The 90-day pact, with named weekly slots (chat card, then popup F)

Compute cadence **N** from the posting and time answers: at least their current frequency, at most what their time budget supports; if either was skipped, use what is there, and if both were skipped, N = 2.

**Then cut N into named slots.** A number is not a plan — "2 posts a week" leaves the creator to decide twice a week what to post, which is the exact decision the report usually says they are losing. Give each slot a weekday and a job, derived in this order: the report's top recommendation takes the first slot; the report's "continue" item takes the second; any further slots repeat the stronger of the two. Spread the weekdays evenly. Every slot's job must trace to the report (or, in the Not-now form and after a failed run, to their stated goal and niche) — never to a generic content calendar.

The measurable target lifts their **median** toward the level their own top content already reached. Render:

> **Your 90-day plan** — until {date +90 days}
> Goal: lift your median views from {X} toward {Y} — the level your own best content already proves possible
> Cadence: {N} posts per week
>
> | slot | day | what goes here |
> |---|---|---|
> | 1 | {weekday} | {the report's top recommendation, as a thing to film} |
> | 2 | {weekday} | {the report's continue item, as a thing to film} |
>
> *"I commit to posting {N} times per week, to grow my channel."*
>
> On {date} we re-measure with the same yardstick.

The `followers_dream` answer is their dream number — acknowledge it as the dream, but the measurable goal stays anchored to their own baseline. In the Not-now form the goal line is omitted, the slots are filled from their stated goal and niche, and the card anchors on cadence only.

Then **group `pact`** — popup F (1 question). The card alone is a statement; the pact is an action the user takes.

Intro: *Here's the plan as it stands. A lighter version is completely fine; the one you'll actually keep is the right one.*

| id | header | question | options |
|---|---|---|---|
| `pact` | The pact | Commit to {N} posts a week until {date}? | I commit / Make it lighter / Make it harder / Not now |

**Settled in one reply. There is no second pact popup.**

- **I commit** → `plan.committed = true`, `committed_at` = now.
- **Make it lighter** → N − 1 (minimum 1). **Make it harder** → N + 1. Apply it, re-cut the slots for the new N, and save with `plan.committed = true` and `committed_at` = now. Then show the re-cut table **as a statement of what was saved**, not as another question: *"Saved: {N} a week, {days}."* Asking them to confirm the number they just chose is the friction this flow was trimmed to remove.
- **Not now** → `plan.committed = false`. Save the plan as it stands. No follow-up, no reasons asked; the close (step 14) is the same warm close.

### 12. Group `content_route` — first move, then one run

The plan names what goes in slot one; it does not yet contain the thing itself. This step fills it. It is where onboarding stops being a questionnaire and becomes the product.

Intro: *Your plan is set; the first slot is still empty. Pick how we fill it — or stop here, the plan is already saved.*

Before the call, resolve the skill for the route the creator is most likely to take via `registry_skill_search` (capability keywords, per `meta-guidance`) and put the matched skill's name / version / permissions into the option descriptions, together with the second run's cost line: this popup **doubles as the pre-run confirmation for the second run**, exactly as step 5 does for the first. State that this is a further run against their own quota and that its size has not been measured yet — see the Estimates block, and never quote a number you do not have.

| id | header | question | options |
|---|---|---|---|
| `content_route` | First move | How should we find your first piece of content? | Recommend three topics for me / I'll name a creator I want to learn from / I'll send a video I want to make my version of / Not now |

| choice | what happens |
|---|---|
| **Recommend three topics for me** | Search for the trend / ideation capability and run it against their saved niche and baseline. Deliver **three** topics, each carrying the evidence that justifies it: what is currently performing, in whose hands, and why it transfers to this account. Never three topics from prior knowledge. |
| **I'll name a creator I want to learn from** | Ask in chat for the handle or link. Search for the channel-research or benchmarking capability and run it on that account, reported **against the creator's own baseline** — what this account does that theirs does not, in their own numbers' terms. |
| **I'll send a video I want to make my version of** | Ask in chat for the URL. Search for the breakout- or video-breakdown capability and run it on that video: hook, structure, and call to action, broken out as things that can be rebuilt. |
| **Not now** | No run. Go straight to step 13. Accept it the first time, no reason asked. |

**One primary skill for this step.** `meta-guidance` rule D holds: these capabilities overlap and extra runs burn paid quota. Run the one that matches the chosen route; add a second only for independent evidence value, and at most one.

**Then, from whatever came back, produce all three of these in one reply:**

1. **The analysis** — what the evidence actually shows, per Section E, with its measurement basis and limitations kept.
2. **A script draft** for slot one, built on that evidence and adapted to their niche, their stated goal, and the account's own baseline.
3. **Recording prep** — what they need in front of the camera to shoot it: the opening line verbatim, the beats in order, and anything that has to be on hand.

**Coverage is not assumed.** Resolve script-writing and recording-prep against `registry_skill_search` too. If a skill covers them, run it. If nothing does, say so plainly in one line and write the draft here from the retrieved evidence — clearly labeled as your own drafting on top of the run's findings, never presented as a skill's output, and never mixed into the statements about retrieved data. A route whose skill search returns nothing is reported as **no coverage**, and the flow continues with the routes that do have it; it is never quietly swapped for prior knowledge or a web search.

Save the route, its subject and the run id → append `"first_move"`.

### 13. What else I can do for you (chat)

Once, at the end, tell them the rest of what is available. Two sources, and neither is a list you write from memory:

- **The platform capabilities**: one `registry_skill_search` sweep over the broad capability directions, and list what actually comes back — relabelled per Section E, one line each, in terms of what the creator would get, not what the skill is called. If the sweep returns nothing, say that nothing else is available right now. Never print a capability that did not come back from the search, and never name a supplier, product, or API behind one.
- **The local entry points**, which you may name literally because they ship in this plugin: `$analyze` for a fresh research question, `$kabo-start` to redo this setup, `$kabo-logout` to sign out.

Keep it to a scannable list. This is an inventory, not a pitch: no urging, no "you should try", no ranking by what you would prefer they run.

### 14. Save + close

Write `<data root>/onboarding-profile.json` (mode 0600) in full:

```json
{
  "schema_version": "kabo-onboarding-profile.v1",

  "handle": "", "platform": "youtube|instagram",

  "answers": {
    "creating": "", "posting": "", "platforms": "", "goal": "",
    "followers_now": "",
    "country": "",
    "account_type": "",
    "referral": "",
    "time": "", "followers_dream": "",
    "niche_area": "", "niche_sub": ""
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
    "slots": [{ "day": "", "job": "" }],
    "start": "", "review": "",
    "committed": false, "committed_at": ""
  },

  "first_move": { "route": "", "subject": "", "run_id": "", "delivered_at": "" },

  "provenance": { "run_id": "", "skill_id": "", "skill_version": "" },

  "onboarded_at": "", "completed_steps": []
}
```

- `answers.*`: the option text as chosen (or the free text). A skipped answer is **absent** from the profile (the key is omitted) — never an empty string, never a placeholder. The keys the 2026-08-26 trim removed (`dream`, `obstacle`, `personality`, `belief`, `grit`, `collabs`, `hook_style`, `scripting`, `on_camera`, `video_length`) are no longer collected and no longer written; a profile carrying them from an earlier run is still valid — leave them alone, do not re-ask, do not delete.
- `plan.slots`: one entry per weekly slot, in the order rendered on the card. `first_experiment` is gone — the first slot's `job` is what it used to hold.
- `diagnosis`, `baseline`, `provenance`: from the run, as produced; `coverage.limitations` carries the run's stated limitations verbatim so a later re-measure has the same yardstick. On the Not-now path there was no run, so all three blocks are **omitted** (not written as empty / zero).
- `first_move`: omitted entirely when step 12 was declined or produced no run.
- `completed_steps`: group keys in the order they were completed, from `basics`, `baseline`, `consent`, `plan_inputs`, `niche_sub`, `niche_reconcile`, `pact`, `first_move`.
- `onboarded_at`: set only here, at the close; its presence is what marks a finished run.

Close in chat:

> That's your setup done, and slot one has something in it.
>
> Saved to `{profile path}` — your answers, your baseline, your plan and your first script. No credentials in it. Delete the file any time and I'll start over.
>
> Before you post, send me the video and I'll check it against your own baseline.

In later sessions, read this profile and greet returning creators from it instead of re-asking anything.

## App steps deliberately not carried over

- **notify** (push-notification permission): no medium equivalent; the return-visit close in step 14 carries that function.
- **intro carousel** ("250,000 accounts analyzed"): fabricated social proof — fails the evidence rules.
- **save / Apple / Google sign-in**: `$kabo-login` already happened; the profile file is the save.
- **free-tier blurred report + paywall**: this is an internal alpha plugin and does not charge; the full report is delivered. This is a deliberate deviation from the product spec's principle 1, recorded here so nobody mistakes it for an oversight.
- **the dream-and-character group, the video-style bonus round, the grit and brand-collaboration questions, and popup D** (cut 2026-08-26): none of them changed the diagnosis, the cadence, the slots or the script, and together they were most of the flow's length. The personality read they were meant to give is better served by what the account actually publishes, which the run measures directly.

## Tool contract — `request_user_input` (what is verified, what is assumed)

Verified against the Codex binary and real session logs (2026-08):

- The call takes `questions` (an array), each with `id`, `header`, `question`, `options: [{label, description}]`, optional `is_secret`. Optional top-level `is_blocking` / `auto_resolution_ms` exist; do not set them here — every popup blocks.
- **Several questions per call are supported**: the tool describes itself as "one to three short questions", and a real call with 2 questions answered in one result exists. **Three is the documented ceiling.** The two 4-question groups above (`basics`, `baseline`) therefore go out as **two calls: 3 questions + 1 question**, under the same stepper label and a single intro line. Do not re-announce the step between the two calls. `plan_inputs` has exactly three and goes out as one call.
- The result is `{"answers": {"<id>": {"answers": ["<label>", ...]}}}`. Unanswered questions are absent from the map — treat absence as a skip, silently.
- **Free text is automatic in the interactive TUI**: the host appends a "None of the above" choice to every question and offers a notes field; typed text comes back as an extra array element prefixed `user_note: `. So **do not add your own "Other" option** where that is the surface; strip the `user_note: ` prefix when saving.
- **Availability is gated by collaboration mode, not by interactivity.** `request_user_input` only renders its popup UI in **Plan Mode**. In **Default mode** — what an interactive session (Desktop app, VS Code extension, CLI) runs unless the user switched modes — the tool is still listed among the task's tools, but a call to it is rejected; degrade to chat immediately, in the same turn, without retrying the call (see Mechanics). This is an upstream Codex limitation: [openai/codex#30150](https://github.com/openai/codex/issues/30150) (open, Desktop-specific reproduction, last update 2026-07-23), [#24750](https://github.com/openai/codex/issues/24750) and [#29104](https://github.com/openai/codex/issues/29104) (both open, VS Code / CLI), and [#15293](https://github.com/openai/codex/issues/15293) (closed, but its repro text is byte-for-byte the fallback pattern this skill produces). It is *also* unavailable in non-interactive `codex exec` (no host to render any UI at all), which is a separate, narrower reason for the same fallback.
  There is an undocumented opt-in that lifts the Default-mode gate: a `[features]` table with `default_mode_request_user_input = true` in `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`), confirmed working on the VS Code extension and CLI in issue comments (#24750, #29104, 2026-05/06) but **not confirmed on the Desktop app** — the one Desktop-specific report (#30150, 2026-07-23) still saw Plan-Mode-only behavior and did not say whether the flag was set. It is absent from the official `[features]` reference table entirely (that page documents `apps`, `goals`, `hooks`, `multi_agent` and similar, never this one), so treat it as unstable: mention it to a user who asks why no popup appears, never assume it is on, and never write it into the user's config yourself — it is machine-wide and outside this skill's data root.

Assumed, and therefore handled defensively (a later maintainer with the schema in hand can tighten these):

- **Whether every surface adds the free-text entry** is not confirmed outside the TUI. On `niche_area` and `niche_sub` — the two questions where a closed list is unacceptable — if you cannot see that the host is adding its own free-text entry, **add an explicit `Something else` option** and, when chosen, ask for the text in one chat line. The same applies to `country`'s *No — I'll type it*.
- **Option count limits** are not documented. Every group above uses at most four options, and a real call has used three; if a call is rejected for option count, do not trim options — report it, since the two plugins' option sets must stay byte-identical.
- **If a multi-question payload is rejected**, fall back to **one question per call**. In that case the stepper label switches to `Question N of 12` (counting only the 12 questionnaire questions, in fixture order; consent, reconcile, pact and the first-move route carry no label) and the "3 groups" wording in the welcome becomes "12 quick questions" — the user must never hear one counting scheme and see another.
- Multi-select is not used anywhere in this flow, so its availability does not matter.

## Hard rules

- Question copy and options are fixed — replicate, don't improvise. The tables above are the source you replicate from. The set is deliberately short; do not add questions back.
- **Never invent numbers**: no fake scores, no invented social proof, no follower projections, and no cost estimate for a run that has never been measured. Every figure comes from a run, from the Estimates block, or is absent.
- Both runs follow `meta-guidance` unchanged (verification, one primary skill per run, Section E delivery, failure semantics). Onboarding changes the framing around a run, never the evidence rules.
- **Every popup that precedes a run carries that run's cost line.** Step 5 does it for the account analysis; step 12 does it for the content run. A run the creator did not knowingly pay for is a bug.
- A script you drafted yourself is labeled as yours, never as a skill's output, and never blended into the statements about retrieved data.
- Never promise virality; the pact's measurable target derives from the creator's own history only.
- Never look for, read, or write a credentials file or token; none exists on this machine.
- Never write the profile anywhere but `<data root>/onboarding-profile.json`.

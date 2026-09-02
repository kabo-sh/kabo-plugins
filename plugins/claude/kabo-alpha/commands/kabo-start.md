---
description: First-run onboarding — the kabo app's guided setup, replicated in Claude Code (tap-through questionnaire, one real account check-up, a 90-day plan, and the first piece of content)
---

# /kabo-start — first-run onboarding

Give a newly signed-in creator a guided first session: a short questionnaire, one real analysis of their own account, a 90-day plan with named weekly slots they commit to, and then the first piece of content that fills the first slot. The flow keeps the kabo mobile app's psychological beats — a real diagnosis before any advice, a plan measured against their own history, a pact they tap rather than read — but it is deliberately **shorter than the app's questionnaire** and it does not stop at the plan. Do not re-expand it, do not add questions back, do not rephrase the ones that are here.

The question set below (copy, options, order, grouping) is authoritative — read it from this file and replicate it. It is shared with the Codex variant, and a regression test in the source repo holds the two in step, so a question that differs between the variants is a bug in the source repo, not a choice you make at run time.

**12 questionnaire questions in 3 groups.** Everything the app asked that did not change an output was cut (2026-08-26): the dream-and-character group, the video-style bonus round, the grit statement, the brand-collaboration question, and the popup that asked how the creator wanted to spend the wait. The two niche levels and the plan inputs are now one step. Cutting them cost nothing downstream — none of them fed the diagnosis, the cadence, or the plan. The product spec fields that survive are the ones a later step actually reads.

## When to run

- `/kabo-login` just verified successfully and `~/.kabo/onboarding-profile.json` does not exist → this is a first sign-in; enter directly (kabo-login.md hands off here).
- `/kabo-analyze` with no arguments and no profile hands off here.
- The user runs `/kabo-start` explicitly, or a profile exists. Read it first and branch on what is in it (see **Resume** below):
  - `onboarded_at` empty → an interrupted run. Offer to continue where they stopped.
  - `onboarded_at` set → a returning creator. Tell them what is on file (handle, goal, cadence) and offer two choices: continue with today's next step, or redo onboarding.

## Mechanics

- Ask every questionnaire step with the **AskUserQuestion** tool — options are tapped, not typed. The questions and options below are verbatim from the fixture; keep them fixed. AskUserQuestion adds an "Other" free-text choice automatically; accept whatever arrives through it.
- Free-text input (the channel link, and the handle or URL in step 12) is asked in chat, not in a popup.
- All user-facing copy in the user's language; the English below is the source copy.
- If AskUserQuestion is not available in this environment, ask the same questions one at a time in chat — same order, same options, always saying that typing their own answer is fine, and counting them as `Question N of 12`.
- **Steps**: every questionnaire group opens with its `Step N of 3` label and its one-line intro (both below), then the questions. The intro is one warm sentence of context, never a pitch, never a second question.
- **Skip is silent.** If the user says skip, later, or simply answers nothing, move on without comment and never come back to that question. A skipped answer is **absent** from the profile (the key is omitted) — never an empty string, never a placeholder. Do not explain what they are missing, do not ask why.
- **Save as you go.** After every completed group, write the profile (schema in step 14) with the group's key appended to `completed_steps`. A closed terminal must never cost the user their answers or a second analysis run.

## Estimates — the single source for time and cost figures

- `{questionnaire_minutes}` = **about a minute** — basis: the 2026-08-20 rehearsal measured ~2 minutes for the then-22-question set; 12 questions scale to about half of that. This is a scaled figure, not a fresh measurement; re-measure and correct it here.
- `{analysis_minutes}` = **10–15** · `{token_estimate}` = **on the order of 100,000 tokens** — measured once (2026-08-20 rehearsal: 12m20s, ~109k tokens on one small account); figures vary with account size.
- `{content_minutes}` and `{content_token_estimate}` for the step-12 run are **not measured yet**. Until a rehearsal produces them, say plainly that this second run spends a further share of their quota and that its size has not been measured — **never quote a number for it**. Inventing one to fill the sentence breaks the evidence rules as surely as inventing a follower count.
- Update all of these from telemetry **here, and only here** — every `{...}` below substitutes these values at run time. Never hardcode figures into the copy.

## Flow

### 1. Welcome (chat)

> Unleash your potential to go viral with AI. Your content deserves to be seen.
>
> Here's the plan: **3 groups of quick questions ({questionnaire_minutes}), one real analysis of your account, a 90-day plan — and then we write your first piece of content together.**
> Say **skip** at any point and I'll continue with whatever you've answered so far.

(The welcome sells the plan, not the price — the analysis cost belongs to the consent popup in step 5, where agreeing to it is the point. Decided 2026-08-22 after review discussion.)

### 2. Popup group 1 — creator basics (one AskUserQuestion call, 4 questions)

`Step 1 of 3` · intro: *First, a quick picture of where you are today. Four taps.*

1. "How long have you been creating content?" — Less than a month / 1–3 months / 3–12 months / More than a year
2. "How many times do you post per week?" — Not every week / Once or twice / 3–5 times / Every day
3. "On how many platforms do you post?" — One platform / Two platforms / Three platforms / Four or more
4. "What is your main goal?" — Grow my audience / Make more money / Build my brand / Go viral

Save → `completed_steps: ["basics"]`.

### 3. Popup group A — starting line (one AskUserQuestion call, 4 questions)

`Step 2 of 3` · intro: *Now your starting line, so the plan is measured against you and nobody else.*

Before asking, infer `{country}` from the shell time zone (`echo $TZ`, falling back to `date +%Z`; map the zone to its most likely country). If no country can be defended, substitute the zone name itself for `{country}` and keep the question text unchanged — never a guess presented as fact. "No — I'll type it" is answered through the free-text entry; take whatever they type as the country. If nothing was typed, leave it absent — do not ask again in chat.

| # | header | question | options |
|---|---|---|---|
| A1 | Followers | "How many followers do you have right now?" | 0–1K / 1K–10K / 10K–250K / 250K+ |
| A2 | Region | "You look like you're creating from {country}. Right?" | Yes, that's right / No — I'll type it |
| A3 | Account type | "Is this account personal or business?" | Personal brand / A business or product / Client work / Not sure yet |
| A4 | Referral | "How did you hear about Kabo?" | Someone on the team / GitHub or the docs / A friend / Somewhere else |

A1 is the creator's **current** follower band; it is deliberately distinct from the dream number asked in step 8.

Save → append `"baseline"`.

### 4. Channel (chat)

> Ready for your diagnosis? Send your channel link or handle — YouTube or Instagram. Public data only: no login, no account connection.

Four things can go wrong with what comes back. Each has one defined response; none of them is a dead end:

- **No platform recognizable** → say that only YouTube and Instagram are supported, show one example of each (`youtube.com/@handle`, `instagram.com/handle`), and ask them to send it again.
- **A single video link** → say plainly that this is one video, not a channel, and ask for the channel or profile link. Do not guess the account from the video.
- **Private account / no public data reachable** → say that public data for this account cannot be read, so there is nothing to analyze this time. Skip the analysis and take the **Not-now path** (step 6). Do not retry.
- **Account not found** → report what actually came back and ask them to check the spelling. At most two retries; if the second retry also fails, take the **Not-now path** without further asking.

### 5. Consent + run confirmation (one AskUserQuestion call, 1 question)

Intro: *Before anything runs: this is your account and your quota, so it is your call.*

Before showing it, resolve the account-review skill via `registry_skill_search` (capability keywords, per meta-guidance) and put the matched skill's name / version / permissions into the question's description text — this popup **doubles as the pre-run confirmation meta-guidance requires**. The description text must also carry, in full:

> Takes about {analysis_minutes} minutes and spends roughly {token_estimate} of your own quota.

"Do you own this account and agree to let Kabo analyze its public data?" — Yes, analyze it / Not now

- **Yes** → step 7.
- **Not now** → the **Not-now path** (step 6). Accept it the first time; do not ask again in this run, and do not ask for a reason.

### 6. Not-now path

No analysis runs. Skip steps 9–10 (the wait and the report). Say one line first, so they know how much is left and that they can stop:

> No problem. One more short group would help shape your plan. Say **skip** and we'll go straight to it.

Then continue with step 8, still saved as it completes. On this path, **skip said once ends the questionnaire** — not just the current group — and the flow goes straight to the plan. In place of the report delivery, say this:

> Without a real run over your videos there is no diagnosis today, so I won't pretend to have one. What I can give you is direction from your answers: {one or two concrete, non-numeric suggestions grounded in their stated goal and niche}. Whenever you want the actual check-up, send me a channel link and I'll run it then.

Then continue with the pact card (step 11), anchored on cadence only — no target median, no baseline numbers — and on to step 12, which does not depend on the account run.

### 7. Launch the real analysis

Follow meta-guidance's single-skill flow exactly (cache check → download → `skill-verify` → dispatch skill-runner). Launch the runner **in the background** if the environment allows and continue to step 8 while it works.

If backgrounding is not possible, say so in one line, ask step 8 first so the questions are out of the way, then run the analysis in the foreground.

There is no longer a popup asking how the creator wants to spend the wait. With one short group left it cost more attention than it saved, and it routinely bought silence the creator had not asked for. The group in step 8 is offered once, plainly, and **skip** ends it — that is the whole consent mechanism now.

Record `provenance.run_id`, `skill_id`, and `skill_version` in the profile as soon as they are known.

### 8. Popup group 3 — plan inputs and niche (two AskUserQuestion calls)

`Step 3 of 3` · intro: *Last step, while the analysis works: the two inputs your plan needs, and your niche.*

**Call one** (3 questions):

1. "How much time are you ready to invest?" — 15 minutes a day / 30 minutes a day / 1 hour a day / As much as it takes
2. "What follower count are you dreaming of?" — 1,000 / 10,000 / 100,000 / 1,000,000+
3. "What's your main content area?" — Lifestyle & personal / Knowledge & skills / Entertainment & creative / Business & professional

**Call two** · header "Sub-niche" · intro: *And one level down.* · "Which of these is closest?" — the four options matching the content-area answer:

| content area | sub-niche options |
|---|---|
| Lifestyle & personal | Fitness & health / Food & cooking / Travel / Fashion & beauty |
| Knowledge & skills | Tech & coding / Finance & investing / Education & how-to / Language & culture |
| Entertainment & creative | Comedy & skits / Gaming / Music & dance / Art & design |
| Business & professional | Marketing & growth / Entrepreneurship / Real estate / Career & productivity |

**A free-text entry must always be available at both niche levels** — this is the one hard warning in the product spec (closed niche lists are a long-standing complaint about comparable apps). AskUserQuestion's automatic Other covers it; if the host ever stops adding it, add an explicit "Something else" option and ask for the text. If the content area was answered in free text, ask the sub-niche with no preset list: same question, free text only. If the content area was skipped, skip the sub-niche too without comment.

Save → append `"plan_inputs"`, then `"niche_sub"`.

### 9. The wait (chat; only while the runner is still working)

The questionnaire now covers about a minute of a run that takes {analysis_minutes}. That gap is not filled with more questions. When step 8 is done and the runner is still working, say once:

> That's all the questions. The analysis is still running — I'll deliver it here the moment it's back. Your answers so far are saved, so you can step away.

Then go quiet, with one exception: about every 3 minutes, one neutral line of progress and nothing else, in this fixed shape:

> Still analyzing — {connector calls completed so far} done, about {N} minutes left.

Never ask whether they are still there, never fill the silence with tips or content the flow does not call for, never ask another question. If the user talks to you in the meantime, answer normally; the heartbeat cadence does not change.

### 10. Deliver the result (chat; when the runner returns)

If the creator has been silent through a long wait, open with an explicit callback before anything else:

> Your analysis is done — here it is whenever you're ready.

Deliver per meta-guidance Section E — the runner's `creator_report` is the body — wrapped in the app's beats:

1. **Real profile card first**: handle, followers, videos analyzed, median views. Real numbers before any judgment; this is what makes the diagnosis credible.
2. **The report**: niche, summary, strengths, weaknesses — whatever the skill produced, baseline numbers kept.
3. **The app's two beats, grounded in the report**:
   - *"Your account has potential."* — name the strongest real signal (e.g. their best video and its multiple over their own median).
   - *"But right now, you're missing the method."* — name the report's biggest actual gap. No invented scores.
4. **Future view, anchored to their own data**:
   > Your best video already hit {X} — {N}× your median. The plan is to make that your baseline, not your outlier.
5. **Niche cross-check** (only if a stated niche exists and the report produced one): one line,
   > The report reads your niche as {inferred}; you described it as {stated}.
   If they match, save and move on. If they differ, do not silently pick either — ask **Popup E**. The saving rule for every outcome is below.

**Popup E — your niche** (one AskUserQuestion call, 1 question; only when inferred ≠ stated)

Intro: *One thing to settle: the report and your own answer see your niche a bit differently. Either is a fine choice.*

header "Your niche" · "Your account reads as {inferred}, but you said {stated}. Which should I save?" — Use {inferred} / Keep {stated} / They're both partly right

Niche rule (identical in both plugins). *Stated* is `niche_sub` if answered, otherwise `niche_area`; *inferred* is the niche the report produced. If the report produced no niche, save nothing here. If no stated niche exists (skipped, or the group was never offered) → `diagnosis.niche` = inferred, `niche_source = "inferred"`, no question. If stated and inferred agree → `diagnosis.niche` = stated, `niche_source = "stated"`, no question. If they differ → Popup E: **Use {inferred}** → `diagnosis.niche` = inferred, `niche_source = "inferred"`; **Keep {stated}** → `diagnosis.niche` = stated, `niche_source = "stated"`; **They're both partly right** → `diagnosis.niche` = `"{stated} / {inferred}"`, `niche_source = "reconciled"`; Popup E skipped → `diagnosis.niche` = stated, `niche_source = "stated"`. `diagnosis.summary` is never edited to hold the other value. Append `"niche_reconcile"`.

If the run failed or came back partial: say what is missing in task terms, deliver what exists, and keep going — the plan then anchors on cadence. Never fabricate a baseline, never leave a dead end.

### 11. The 90-day pact, with named weekly slots (chat card + Popup F)

Compute cadence **N** from the posting and time answers: at least their current frequency, at most what their time budget supports; if either was skipped, use what is there, and if both were skipped, N = 2.

**Then cut N into named slots.** A number is not a plan — "2 posts a week" leaves the creator to decide twice a week what to post, which is the exact decision the report usually says they are losing. Give each slot a weekday and a job, derived in this order: the report's top recommendation takes the first slot; the report's "continue" item takes the second; any further slots repeat the stronger of the two. Spread the weekdays evenly. Every slot's job must trace to the report (or, on the Not-now path and after a failed run, to their stated goal and niche) — never to a generic content calendar.

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

On the Not-now path, or after a failed run, drop the Goal line and fill the slots from their stated goal and niche instead; the card anchors on cadence only.

The followers answer is their dream number — acknowledge it as the dream, but the measurable goal stays anchored to their own baseline.

**Popup F — the pact** (one AskUserQuestion call, 1 question). The card is something to read; the pact is something they do, so it must be tapped, not printed.

Intro: *Here's the plan as it stands. A lighter version is completely fine; the one you'll actually keep is the right one.*

header "The pact" · "Commit to {N} posts a week until {date}?" — I commit / Make it lighter / Make it harder / Not now

**Settled in one reply. There is no second pact popup.**

- **I commit** → `plan.committed = true`, `committed_at` = now.
- **Make it lighter** → N − 1 (minimum 1). **Make it harder** → N + 1. Apply it, re-cut the slots for the new N, and save with `plan.committed = true` and `committed_at` = now. Then show the re-cut table **as a statement of what was saved**, not as another question: *"Saved: {N} a week, {days}."* Asking them to confirm the number they just chose is the friction this flow was trimmed to remove.
- **Not now** → `plan.committed = false`. Save the plan as it stands. No follow-up, no reasons asked.

Append `"pact"`.

### 12. First move — turn the plan into actual content (Popup G, then one run)

The plan names what goes in slot one; it does not yet contain the thing itself. This step fills it. It is where onboarding stops being a questionnaire and becomes the product.

**Popup G — first move** (one AskUserQuestion call, 1 question)

Intro: *Your plan is set; the first slot is still empty. Pick how we fill it — or stop here, the plan is already saved.*

Before showing it, resolve the skill for the route the creator is most likely to take via `registry_skill_search` (capability keywords, per meta-guidance) and put the matched skill's name / version / permissions into the description text, together with the second run's cost line: this popup **doubles as the pre-run confirmation for the second run**, exactly as step 5 does for the first. State that this is a further run against their own quota and that its size has not been measured yet — see the Estimates block, and never quote a number you do not have.

header "First move" · "How should we find your first piece of content?" — Recommend three topics for me / I'll name a creator I want to learn from / I'll send a video I want to make my version of / Not now

| choice | what happens |
|---|---|
| **Recommend three topics for me** | Search for the trend / ideation capability and run it against their saved niche and baseline. Deliver **three** topics, each carrying the evidence that justifies it: what is currently performing, in whose hands, and why it transfers to this account. Never three topics from prior knowledge. |
| **I'll name a creator I want to learn from** | Ask in chat for the handle or link. Search for the channel-research or benchmarking capability and run it on that account, reported **against the creator's own baseline** — what this account does that theirs does not, in their own numbers' terms. |
| **I'll send a video I want to make my version of** | Ask in chat for the URL. Search for the breakout- or video-breakdown capability and run it on that video: hook, structure, and call to action, broken out as things that can be rebuilt. |
| **Not now** | No run. Go straight to step 13. Accept it the first time, no reason asked. |

**One primary skill for this step.** Meta-guidance rule D holds: these capabilities overlap and extra runs burn paid quota. Run the one that matches the chosen route; add a second only for independent evidence value, and at most one.

**Then, from whatever came back, produce all three of these in one reply:**

1. **The analysis** — what the evidence actually shows, per Section E, with its measurement basis and limitations kept.
2. **A script draft** for slot one, built on that evidence and adapted to their niche, their stated goal, and the account's own baseline.
3. **Recording prep** — what they need in front of the camera to shoot it: the opening line verbatim, the beats in order, and anything that has to be on hand.

**Coverage is not assumed.** Resolve script-writing and recording-prep against `registry_skill_search` too. If a skill covers them, run it. If nothing does, say so plainly in one line and write the draft here from the retrieved evidence — clearly labeled as your own drafting on top of the run's findings, never presented as a skill's output, and never mixed into the statements about retrieved data. A route whose skill search returns nothing is reported as **no coverage**, and the flow continues with the routes that do have it; it is never quietly swapped for prior knowledge or a web search.

Save the route, its subject, and the run id → append `"first_move"`.

### 13. What else I can do for you (chat)

Once, at the end, tell them the rest of what is available. Two sources, and neither is a list you write from memory:

- **The platform capabilities**: one `registry_skill_search` sweep over the broad capability directions, and list what actually comes back — relabelled per Section E, one line each, in terms of what the creator would get, not what the skill is called. If the sweep returns nothing, say that nothing else is available right now. Never print a capability that did not come back from the search, and never name a supplier, product, or API behind one.
- **The local commands**, which you may name literally because they ship in this plugin: `/kabo-analyze` for a fresh research question, `/kabo-start` to redo this setup, `/kabo-logout` to sign out.

Keep it to a scannable list. This is an inventory, not a pitch: no urging, no "you should try", no ranking by what you would prefer they run.

### 14. Save + close

Write `~/.kabo/onboarding-profile.json` (mode 0600) — the same file that was written after every group, now with `onboarded_at` set:

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
- `completed_steps`: group keys in the order they were completed, from `basics`, `baseline`, `consent`, `plan_inputs`, `niche_sub`, `niche_reconcile`, `pact`, `first_move`. Keys from a superseded version of this flow (`wait`, `dream`, `niche_area`, `commitment`, `style`) may appear in an older profile; treat them as satisfied where they overlap and ignore the rest, rather than restarting the creator.
- `onboarded_at`: set only here, at the close; its presence is what marks a finished run.

Close in chat:

> That's your setup done, and slot one has something in it.
>
> Saved to `~/.kabo/onboarding-profile.json` — your answers, your baseline, your plan and your first script. No credentials in it. Delete the file any time and I'll start over.
>
> Before you post, send me the video and I'll check it against your own baseline.

In later sessions, read this profile and greet returning creators from it instead of re-asking anything.

## Resume

The profile is written after every group, so an interrupted run is a normal case, not a failure.

- Profile exists and `onboarded_at` is empty → say how far they got and ask (one AskUserQuestion call, header "Welcome back"): "You got through {N} of the question groups last time. Pick up where you left off?" — Continue / Start over.
  - **Continue** → resume at the first group not in `completed_steps`, in flow order. If `provenance.run_id` and `baseline.measured_at` are set, the analysis already ran: do not run it again; go to delivery (step 10) once step 8 is done. If the run never completed, re-launch it (cost line and consent shown again, since it is a new spend).
  - **Start over** → discard the answers and begin at step 1. If `baseline.measured_at` is within 30 days, keep `baseline`, `diagnosis` and `provenance`, **skip steps 4–7** (channel, consent, launch) and go from group A straight to step 8 — the consent popup is shown only when a new run will actually be launched. Otherwise step 4 onward runs as on a first pass.
- Profile complete (`onboarded_at` set) and the user asks to **redo onboarding** → the questionnaire and plan are redone. If `baseline.measured_at` is within 30 days, the analysis is **not** re-run: steps 4–7 are skipped and group A leads straight into step 8. If it is older than 30 days, the consent popup (step 5) with its cost line is shown again; accepting re-runs the analysis, declining keeps the old baseline, says so in one line, and skips step 7.
- A complete profile whose `first_move` is absent → step 12 is the natural next step for a returning creator; offer it as today's next step rather than redoing the questionnaire.

## App steps deliberately not carried over

- **notify** (push-notification permission): no medium equivalent; the return-visit close in step 14 carries that function.
- **intro carousel** ("250,000 accounts analyzed"): fabricated social proof — fails the evidence rules.
- **save / Apple / Google sign-in**: `/kabo-login` already happened; the profile file is the save.
- **paywall / blurred report** (the product spec's principle 1: the free tier gets the shape of the report and the paywall lands the second the diagnosis finishes): deliberately not replicated. The internal alpha plugin is not monetized, so the report is delivered in full. This is a recorded deviation from the product spec, not an oversight.
- **the dream-and-character group, the video-style bonus round, the grit and brand-collaboration questions, and the wait-preference popup** (cut 2026-08-26): none of them changed the diagnosis, the cadence, the slots or the script, and together they were most of the flow's length. The personality read they were meant to give is better served by what the account actually publishes, which the run measures directly.

## Hard rules

- Question copy and options are fixed — replicate, don't improvise. The set is deliberately short; do not add questions back.
- **Never invent numbers**: no fake scores, no invented social proof, no follower projections, and no cost estimate for a run that has never been measured. Every figure comes from a run, from the Estimates block, or is absent.
- Both runs follow meta-guidance unchanged (verification, one primary skill per run, Section E delivery, failure semantics). Onboarding changes the framing around a run, never the evidence rules.
- **Every popup that precedes a run carries that run's cost line.** Step 5 does it for the account analysis; step 12 does it for the content run. A run the creator did not knowingly pay for is a bug.
- A script you drafted yourself is labeled as yours, never as a skill's output, and never blended into the statements about retrieved data.
- Never promise virality; the pact's measurable target derives from the creator's own history only.
- **Never pressure.** Skip and Not now are each accepted the first time, silently, and never revisited in the run. The wait is quiet apart from the fixed heartbeat line. The pact is settled in one reply. Nothing is re-pitched, and no answer is ever demanded.

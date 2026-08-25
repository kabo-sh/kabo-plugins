---
description: First-run onboarding — the kabo app's guided setup, replicated in Claude Code (tap-through questionnaire, one real account check-up, a 90-day plan)
---

# /kabo-start — first-run onboarding

Give a newly signed-in creator the same guided first session as the kabo mobile app's onboarding: a short questionnaire, one real analysis of their own account, and a 90-day plan they commit to. The design intent is **faithful replication of the app flow** — same questions, same options, same order, same psychological beats — adapted only where the medium physically differs, and extended with the profile fields the product spec requires that the app's questionnaire does not collect. Do not re-minimize it, do not skip questionnaire steps, do not rephrase questions.

The question set below (copy, options, order, grouping) is authoritative — read it from this file and replicate it. It is shared with the Codex variant, and a regression test in the source repo holds the two in step, so a question that differs between the variants is a bug in the source repo, not a choice you make at run time.

## When to run

- `/kabo-login` just verified successfully and `~/.kabo/onboarding-profile.json` does not exist → this is a first sign-in; enter directly (kabo-login.md hands off here).
- `/kabo-analyze` with no arguments and no profile hands off here.
- The user runs `/kabo-start` explicitly, or a profile exists. Read it first and branch on what is in it (see **Resume** below):
  - `onboarded_at` empty → an interrupted run. Offer to continue where they stopped.
  - `onboarded_at` set → a returning creator. Tell them what is on file (handle, goal, cadence) and offer two choices: continue with today's next step, or redo onboarding.

## Mechanics

- Ask every questionnaire step with the **AskUserQuestion** tool — options are tapped, not typed. The questions and options below are verbatim from the app and the fixture; keep them fixed. AskUserQuestion adds an "Other" free-text choice automatically; accept whatever arrives through it.
- Free-text input (the channel link) is asked in chat, not in a popup.
- All user-facing copy in the user's language; the English below is the source copy.
- If AskUserQuestion is not available in this environment, ask the same questions one at a time in chat — same order, same options, and always say that typing their own answer is fine.
- **Steps**: every questionnaire group opens with its `Step N of 6` label and its one-line intro (both below), then the questions. The intro is one warm sentence of context, never a pitch, never a second question.
- **Skip is silent.** If the user says skip, later, or simply answers nothing, move on without comment and never come back to that question. A skipped answer is **absent** from the profile (the key is omitted) — never an empty string, never a placeholder. Do not explain what they are missing, do not ask why.
- **Save as you go.** After every completed group, write the profile (schema in step 16) with the group's key appended to `completed_steps`. A closed terminal must never cost the user their answers or a second analysis run.

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

### 2. Popup group 1 — creator basics (one AskUserQuestion call, 4 questions)

`Step 1 of 6` · intro: *First, a quick picture of where you are today. Four taps.*

1. "How long have you been creating content?" — Less than a month / 1–3 months / 3–12 months / More than a year
2. "How many times do you post per week?" — Not every week / Once or twice / 3–5 times / Every day
3. "On how many platforms do you post?" — One platform / Two platforms / Three platforms / Four or more
4. "What is your main goal?" — Grow my audience / Make more money / Build my brand / Go viral

Save → `completed_steps: ["basics"]`.

### 3. Popup group A — starting line (one AskUserQuestion call, 4 questions)

`Step 2 of 6` · intro: *Now your starting line, so the plan is measured against you and nobody else.*

Before asking, infer `{country}` from the shell time zone (`echo $TZ`, falling back to `date +%Z`; map the zone to its most likely country). If no country can be defended, substitute the zone name itself for `{country}` and keep the question text unchanged — never a guess presented as fact. "No — I'll type it" is answered through the free-text entry; take whatever they type as the country. If nothing was typed, leave it absent — do not ask again in chat.

| # | header | question | options |
|---|---|---|---|
| A1 | Followers | "How many followers do you have right now?" | 0–1K / 1K–10K / 10K–250K / 250K+ |
| A2 | Region | "You look like you're creating from {country}. Right?" | Yes, that's right / No — I'll type it |
| A3 | Account type | "Is this account personal or business?" | Personal brand / A business or product / Client work / Not sure yet |
| A4 | Referral | "How did you hear about Kabo?" | Someone on the team / GitHub or the docs / A friend / Somewhere else |

A1 is the creator's **current** follower band; it is deliberately distinct from the dream number asked in group 3.

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

No analysis runs. Skip step 8 (the wait question), step 12 (the bonus round — it is not offered on this path) and steps 13–14 (heartbeats and the report). Say one line first, so they know how much is left and that they can stop:

> No problem. A few more questions would help shape your plan — about two minutes. Say **skip** at any point and we'll go straight to the plan.

Then continue with groups 2, B1, B2, 3 (steps 9–11), each still saved as it completes. On this path, **skip said once ends the questionnaire** — not just the current group — and the flow goes straight to the closing copy below. Then, in place of the report delivery, say this:

> Without a real run over your videos there is no diagnosis today, so I won't pretend to have one. What I can give you is direction from your answers: {one or two concrete, non-numeric suggestions grounded in their stated goal, obstacle, and niche}. Whenever you want the actual check-up, send me a channel link and I'll run it then.

Then continue with the pact card (step 15), anchored on cadence only — no target median, no baseline numbers.

### 7. Launch the real analysis

Follow meta-guidance's single-skill flow exactly (cache check → download → `skill-verify` → dispatch skill-runner). Launch the runner **in the background** if the environment allows and continue to step 8 while it works. If backgrounding is not possible, still ask step 8 first (so the choice is theirs) but with its **foreground intro** instead of the background one, then run the questionnaire groups their choice allows, then run the analysis in the foreground. In the foreground case, "Nothing — ping me when it's done" means the run starts straight away.

Record `provenance.run_id`, `skill_id`, and `skill_version` in the profile as soon as they are known.

### 8. Popup D — how to wait (one AskUserQuestion call, 1 question)

`Step 3 of 6` · intro: *The analysis is running in the background. Whatever you pick here is fine, and I'll stick to it.*

Foreground intro (only when the runner could not be backgrounded, step 7): *The analysis will run next and takes about {analysis_minutes} minutes. Anything you'd like to answer first? Whatever you pick is fine — "Nothing" starts the run straight away.*

"The analysis takes about {analysis_minutes} minutes. How do you want to spend it?" — Keep answering questions / Just the essentials, then leave me alone / Nothing — ping me when it's done

| choice | what happens |
|---|---|
| **Keep answering questions** | steps 9, 10, 11, 12 in order, then the silent wait (step 13) |
| **Just the essentials, then leave me alone** | steps 9 and 10 only; steps 11 and 12 are skipped, then the silent wait |
| **Nothing — ping me when it's done** | steps 9–12 all skipped; write the partial profile now; silent wait; the first line of delivery is an explicit callback (step 14) |

This is asked **once**. Whatever they chose holds for the rest of the run — never re-offer the skipped groups, never ask "one more?". Save → append `"wait"`.

### 9. Popup group 2 — dream and character (one AskUserQuestion call, 4 questions)

`Step 4 of 6` · intro: *While it works, a little about what you're really after. There are no wrong answers here.*

1. "What is your ultimate dream?" — Build a massive audience / Make content my full-time job / Help people with my story / Leave a legacy
2. "What prevents you from achieving this dream?" — I don't know what to post / I struggle with consistency / I need better feedback / I compare myself to others
3. "Are you more of an introvert or an extrovert?" — Introvert / Extrovert / A bit of both
4. "When a video doesn't work, I tend to doubt myself." — Not really me / Sometimes / Often / Totally me

(The app renders question 4 here and question 1 in group 3 as a five-emoji scale; four labeled options is the closest AskUserQuestion allows.)

Save → append `"dream"`.

### 10. Popup group B — niche, two levels (two AskUserQuestion calls, 1 question each)

`Step 5 of 6` · intro: *Your niche, in two taps. If none of these fit, just type your own.*

**B1** · header "Niche" · "What's your main content area?" — Lifestyle & personal / Knowledge & skills / Entertainment & creative / Business & professional

**B2** · header "Sub-niche" · intro: *And one level down.* · "Which of these is closest?" — the four options matching the B1 answer:

| B1 | B2 options |
|---|---|
| Lifestyle & personal | Fitness & health / Food & cooking / Travel / Fashion & beauty |
| Knowledge & skills | Tech & coding / Finance & investing / Education & how-to / Language & culture |
| Entertainment & creative | Comedy & skits / Gaming / Music & dance / Art & design |
| Business & professional | Marketing & growth / Entrepreneurship / Real estate / Career & productivity |

**A free-text entry must always be available at both levels** — this is the one hard warning in the product spec (closed niche lists are a long-standing complaint about comparable apps). AskUserQuestion's automatic Other covers it; if the host ever stops adding it, add an explicit "Something else" option and ask for the text. If B1 was answered in free text, ask B2 with no preset list: same question, free text only. If B1 was skipped, skip B2 too without comment.

Save → append `"niche_area"`, then `"niche_sub"`.

### 11. Popup group 3 — commitment inputs (one AskUserQuestion call, 4 questions)

`Step 6 of 6` · intro: *Last group: the inputs for your plan. Answer as you are, not as you think you should be.*

1. "I'm the type to keep going even when it's hard." — Not really me / Sometimes / Often / Totally me
2. "How much time are you ready to invest?" — 15 minutes a day / 30 minutes a day / 1 hour a day / As much as it takes
3. "What follower count are you dreaming of?" — 1,000 / 10,000 / 100,000 / 1,000,000+
4. "Would you be open to paid brand collaborations?" — Yes / Maybe later / No

Save → append `"commitment"`.

### 12. Popup group C — how your videos are made (one AskUserQuestion call, 4 questions)

No step label (the six steps are done; this is the bonus round). Intro: *Bonus round, only if you feel like it: how your videos are made. Skip any of these freely.*

| # | header | question | options |
|---|---|---|---|
| C1 | Hook style | "How do most of your videos start?" | A question / A bold claim / A story / No fixed pattern |
| C2 | Scripting | "Do you script before filming?" | Full script / Bullet points / I improvise / Depends |
| C3 | On camera | "Are you on camera?" | Always / Sometimes / Voice only / Never |
| C4 | Length | "How long are your videos usually?" | Under 30s / 30–60s / 1–3 min / Over 3 min |

These feed the profile's content-style fields and the later script tooling; nothing in this run depends on them. Save → append `"style"`.

### 13. The wait (chat; only while the runner is still working)

The 2026-08-20 rehearsal measured ~2 minutes of questions against ~12 minutes of analysis; even the full questionnaire now covers only about a third of the run. That gap is not filled with more questions. When the questionnaire (whatever Popup D allowed of it) is done and the runner is still working, say once:

> That's all the questions. The analysis is still running — I'll deliver it here the moment it's back. Your answers so far are saved, so you can step away.

Then go quiet, with one exception: about every 3 minutes, one neutral line of progress and nothing else, in this fixed shape:

> Still analyzing — {connector calls completed so far} done, about {N} minutes left.

Never ask whether they are still there, never fill the silence with tips or content the flow does not call for, never ask another question. If the user talks to you in the meantime, answer normally; the heartbeat cadence does not change.

### 14. Deliver the result (chat; when the runner returns)

If Popup D was **Nothing — ping me when it's done**, the first line is an explicit callback, before anything else:

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

### 15. The 90-day pact (chat card + Popup F)

Compute: cadence **N** from the posting + time answers (at least their current frequency, at most what their time budget supports; if either was skipped, use what is there, and if both were skipped, N = 2). The measurable target lifts their **median** toward the level their own top content already reached. Render:

> **Your 90-day plan** — until {date +90 days}
> Goal: lift your median views from {X} toward {Y} — the level your own best content already proves possible
> Cadence: {N} posts per week
> First experiment: {the report's top recommendation}
>
> *"I commit to posting {N} times per week, to grow my channel."*
>
> On {date} we re-measure with the same yardstick.

On the Not-now path, or after a failed run, drop the Goal line and the first-experiment line's report dependency (use the best questionnaire-based suggestion instead); the card anchors on cadence only.

The followers answer (group 3, Q3) is their dream number — acknowledge it as the dream, but the measurable goal stays anchored to their own baseline.

**Popup F — the pact** (one AskUserQuestion call, 1 question). The card is something to read; the pact is something they do, so it must be tapped, not printed.

Intro: *Here's the plan as it stands. A lighter version is completely fine; the one you'll actually keep is the right one.*

header "The pact" · "Commit to {N} posts a week until {date}?" — I commit / Make it lighter / Make it harder / Not now

- **I commit** → `plan.committed = true`, `committed_at` = now.
- **Make it lighter** → N − 1 (minimum 1); **Make it harder** → N + 1. Re-render the card once with the new N and ask Popup F once more, same intro. If the second answer is again lighter or harder, apply it, re-render the card, and save that plan with `committed = false` — a plan they shaped is the outcome; there is no third popup and no pledge is extracted.
- **Not now** → `plan.committed = false`. Save the plan as it stands. No follow-up, no reasons asked; the close (step 16) is the same warm close.

Append `"pact"`.

### 16. Save + close

Write `~/.kabo/onboarding-profile.json` (mode 0600) — the same file that was written after every group, now with `onboarded_at` set:

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
- `completed_steps`: group keys in the order they were completed, from `basics`, `baseline`, `consent`, `wait`, `dream`, `niche_area`, `niche_sub`, `commitment`, `style`, `niche_reconcile`, `pact`.
- `onboarded_at`: set only here, at the close; its presence is what marks a finished run.

Close in chat:

> That's your setup done. Two things I can do whenever you're ready:
> - before you post, send me the video — I'll check it against your own baseline;
> - say **trends** and I'll show you what's working in your niche right now.
>
> Saved to `~/.kabo/onboarding-profile.json` — your answers, your baseline, and this plan. No credentials in it. Delete the file any time and I'll start over.

In later sessions, read this profile and greet returning creators from it instead of re-asking anything.

## Resume

The profile is written after every group, so an interrupted run is a normal case, not a failure.

- Profile exists and `onboarded_at` is empty → say how far they got and ask (one AskUserQuestion call, header "Welcome back"): "You got through {N} of the question groups last time. Pick up where you left off?" — Continue / Start over.
  - **Continue** → resume at the first group not in `completed_steps`, in flow order. If `provenance.run_id` and `baseline.measured_at` are set, the analysis already ran: do not run it again; go to delivery (step 14) once the remaining wait-phase groups their Popup D choice allowed are done. If the run never completed, re-launch it (cost line and consent shown again, since it is a new spend).
  - **Start over** → discard the answers and begin at step 1. If `baseline.measured_at` is within 30 days, keep `baseline`, `diagnosis` and `provenance`, **skip steps 4–8** (channel, consent, launch, Popup D) and go from group A straight to group 2 — the consent popup is shown only when a new run will actually be launched. Otherwise step 4 onward runs as on a first pass.
- Profile complete (`onboarded_at` set) and the user asks to **redo onboarding** → the questionnaire and plan are redone. If `baseline.measured_at` is within 30 days, the analysis is **not** re-run: steps 4–8 are skipped and group A leads straight into group 2. If it is older than 30 days, the consent popup (step 5) with its cost line is shown again; accepting re-runs the analysis, declining keeps the old baseline, says so in one line, and skips steps 7–8.

## App steps deliberately not carried over

- **notify** (push-notification permission): no medium equivalent; the return-visit close in step 16 carries that function.
- **intro carousel** ("250,000 accounts analyzed"): fabricated social proof — fails the evidence rules.
- **save / Apple / Google sign-in**: `/kabo-login` already happened; the profile file is the save.
- **paywall / blurred report** (the product spec's principle 1: the free tier gets the shape of the report and the paywall lands the second the diagnosis finishes): deliberately not replicated. The internal alpha plugin is not monetized, so the report is delivered in full. This is a recorded deviation from the product spec, not an oversight.

## Hard rules

- Question copy and options are fixed — replicate, don't improvise.
- **Never invent numbers**: no fake scores, no invented social proof, no follower projections. Every figure comes from the run or is absent.
- The skill run itself follows meta-guidance unchanged (verification, Section E delivery, failure semantics). Onboarding changes the framing around the run, never the evidence rules.
- Never promise virality; the pact's measurable target derives from the creator's own history only.
- **Never pressure.** Skip, later, Not now and "Nothing — ping me" are each accepted the first time, silently, and never revisited in the run. The wait is quiet apart from the fixed heartbeat line. Nothing is re-pitched, and no answer is ever demanded.

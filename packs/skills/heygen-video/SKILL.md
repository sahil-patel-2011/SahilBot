---
name: heygen-video
description: Make HeyGen avatar videos, dubbed translations and HyperFrames motion graphics: script, avatar and voice, aspect ratio, captions, credits, review.
source: you
uses: 0
category: Media
triggers: heygen, avatar video, talking head video, ai presenter, spokesperson video, dub this video, translate my video, lip sync, explainer video, motion graphics, hyperframes, animated slides, video script, heygen credits
---

## When
A presenter reading a script (launch, training, onboarding, outreach, social clip), a video dubbed into another language, or an animated explainer. All of it runs through `video(...)` on the user's HeyGen plan and spends their credits. HeyGen can't trim or cut the user's own footage.

## Steps
1. **Pin the brief** (ask only what you can't infer): goal, audience, platform (sets the aspect), length, call to action, captions, language.
2. **Write the script** before touching HeyGen (see rules below). About 150 words per minute: 15 s ≈ 38 words, 30 s ≈ 75, 60 s ≈ 150. Show longer scripts first: a rewrite is free, a re-render isn't.
3. **Pick the avatar and voice**: `video(action="list_avatars")`, `video(action="list_voices", query="female English")`. Prefer the user's digital twin or a look they used before; match the voice's language and gender. Not connected: the first call shows a one-click Connect card; call again after.
4. **Make it**: `video(action="create_avatar_video", script, avatar, voice, aspect, captions, background, title)`. The approval card shows the credit estimate.
5. **Don't poll.** The app watches the render, saves `videos/<title>.mp4` and posts it in the chat, where it plays. Say roughly how long (5–10× the video's length) and carry on.
6. **Check the result** when it lands (see Verify), then offer the fix or the next format.

## Script rules
- Hook in the first sentence (3 seconds): the problem, a number, or the payoff. No "Hi, I'm…" openers.
- One idea per video; three points at most; end with one clear call to action.
- Write for the ear: 8–15-word sentences, contractions, everyday words, active voice.
- Spell out what TTS mispronounces: numbers, units, acronyms ("A-P-I"), odd product names. No URLs: say "link below".
- Punctuation paces it: comma = short pause, full stop = longer, new paragraph = a beat.
- No stage directions or brackets in the script: the avatar reads every character.

## Avatar, voice, background
- Same avatar and voice across a series; warm mid-pace voice for explainers, brisker for ads.
- Background: a brand hex (`"#0F172A"`) or an https image, calm behind a face. B-roll and screen recordings: a motion video or HeyGen's editor.

## Aspect ratio by platform
- 9:16: TikTok, Reels, Shorts, Stories. Keep the face in the upper middle; captions on.
- 16:9: YouTube, websites, LinkedIn video, training, presentations.
- 1:1: feed posts on LinkedIn, Facebook, X where a square fills more of the screen.

## Captions
On for social (most watch muted) and accessibility; check names and jargon in them.

## Translation
`video(action="translate_video", video_url_or_path, target_language, lip_sync)`. Lip sync (default) for a face on camera; `lip_sync=false` (cheaper) for screen recordings and voice-over. Clean audio, one speaker at a time, little music. A local file is uploaded only after the user approves it by name. Review one short video before a whole library.

## HyperFrames (motion graphics, slides, explainers)
`video(action="make_motion_video", brief)`: scenes, on-screen text, length (≤ 90 s), style (`blockframe` playful, `claude` editorial, `mat` premium, `monochrome` scholarly, `signal` briefing). Media: public https file links. A question from it: `status {id}` shows it; answer with `make_motion_video {brief, project_id}`.

## Credits
Published rates (credits per minute): Avatar III 4, Avatar IV video look 31 (photo look 16), translation 6 with lip sync (precision 10), 4 voice only. `video(action="credits")` shows the balance. Routines never spend without a standing approval. A discarded render still costs.

## Verify
Watch it end to end: words match the script, names right, lips in sync, captions correct, nothing cropped, CTA present. Report length, file and credits; offer one improvement.

## Example
"Make a 30-second avatar video about our launch" → 75-word script with a hook and CTA → list_avatars/list_voices → create_avatar_video {aspect "16:9", captions true, title "Launch announcement"} → approve ~16 credits → the video plays in the chat from videos/launch-announcement.mp4.

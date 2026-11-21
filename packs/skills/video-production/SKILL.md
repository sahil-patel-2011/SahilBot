---
name: video-production
description: Plan and make any video end to end: research, brief, script, shot list, the right platform (HeyGen, Higgsfield, invideo, Vimeo) at its best quality settings, review, fixes and delivery.
source: you
uses: 0
category: Media
triggers: make a video, build a video, create a video, video about, video for, promo video, ad video, explainer video, product video, demo video, short video, reel, tiktok video, youtube video, youtube short, cinematic, hyperrealistic, photorealistic video, b-roll, ai video, text to video, image to video, higgsfield, invideo, vimeo, video script, storyboard, shot list
---

## When
The user wants a finished video: an ad, an explainer, a product demo, a social clip, a cinematic or hyperrealistic scene, a presenter video, or an upload to Vimeo. Plan it properly, make it on the best platform for the job at its highest-quality settings, check it, and deliver more than was asked when it helps (thumbnail, title, description, captions, cut-downs).

## 1. Research (before asking anything)
- The topic: facts, numbers, the audience's real questions, 2-3 strong examples of videos like this (web_search). Save the facts you'll use with sources.
- The craft: what makes this kind of video work (hook in 3 seconds, one idea, pacing for its length, the platform's format). Read the platform's own guide when you use it for the first time.

## 2. Ask only what's the user's call, in one ask_user card
2-4 short questions, each with options and your default first. Typical: "How long should the video be?" (15 s / 30 s / 60 s / 2 min), "Where will it go?" (YouTube / Reels and TikTok / website / LinkedIn), "Which look?" (hyperrealistic / cinematic film / animated / presenter on camera), "Voice?" (AI narrator / an avatar presenter / music only). Skip anything the request already says. The chat waits on the card; no tokens are spent while it does.

## 3. The plan (propose_plan for anything over ~30 s or that spends credits)
- Brief: goal, audience, platform, aspect ratio (9:16 vertical, 16:9 wide, 1:1 square), length, look, call to action.
- Script: spoken lines, about 150 words per minute (30 s ≈ 75 words). Hook first, one idea, clear ending.
- Shot list: one line per shot, 3-8 s each for generated footage. For each: what we see, camera, lighting, motion, on-screen text, the line of script over it.
- Platform and settings (below), credits estimate, and what you'll deliver.

## 4. Pick the platform
- **Hyperrealistic or cinematic footage** (people, products, places, scenes): Higgsfield (find_tools("higgsfield")). Generate shot by shot, then assemble.
- **Edited explainer, ad or social video from a script** with stock footage, voice-over, music and captions: invideo AI (find_tools("invideo")).
- **A presenter speaking to camera, or dubbing into another language**: HeyGen (the `video` tool; read the heygen-video skill).
- **Animated graphics, slides, data**: HeyGen HyperFrames (`video` make_motion_video).
- **Hosting and sharing**: Vimeo (find_tools("vimeo")): upload, title, description, privacy, showcase.
- Not connected? The first call shows the one-click Connect card; once connected, carry on without asking again. Platforms on the web without a connector: use the browser (signing in is part of the job: fill_secret or wait_for_signin).

## 5. Settings: always the best the platform offers for the look asked
- Read each tool's parameters before the first call; pick its highest-quality model, the highest resolution (1080p or 4K where offered) and the frame rate that fits (24 fps cinematic, 30 fps social), the aspect from the brief.
- **Hyperrealistic prompts**, one shot each, in this order: subject and action; setting; camera (lens in mm, angle, distance, movement: "slow dolly in", "handheld", "locked-off"); lighting ("soft window light", "golden hour backlight", "overcast"); look ("shot on 35mm film, natural skin texture, shallow depth of field"); mood. Add what to avoid if the tool takes it (warped hands, text artifacts, plastic skin, extra fingers).
- **Consistency**: the same character description and reference image in every shot, a fixed seed when offered, the same lighting and color words across shots.
- Animated or stylized looks: name the style precisely ("flat vector, 2-color palette", "claymation", "anime cel shading").
- Voice and music: a voice that fits the audience, music under the voice (not over it), captions on for social.

## 6. Make it
Generate shots in parallel when the tool allows, then assemble in order with the script, music and captions. Spending credits shows the approval card with the estimate; after approval keep going without asking again. Long renders: don't poll in a loop; wait once, then check.

## 7. Review like an editor (never skip)
Watch it (or check frames at the start, middle and end of each shot): matches the script, faces and hands look right, nothing warped or flickering, text spelled correctly, cuts on the beat, audio level steady, captions match, the length is right, the call to action is there. Regenerate the weak shots (change one thing in the prompt at a time), not the whole video.

## 8. Deliver, and go one better
The file (or link) in the chat, plus: a title, a description with the key points, a thumbnail idea (or a generated thumbnail), captions, and the cut the platform favors (a 9:16 cut-down of a 16:9 video for Reels). Upload to Vimeo or the named platform when asked, with the title, description and privacy set. Report the length, platform, settings used and credits spent.

## Example
"Sign in to Vimeo and make a video about our new espresso machine" → research the machine and great product videos → ask length / look / voice in one card (user: 30 s, hyperrealistic, narrator) → plan: 75-word script, 6 shots (macro crema pour, steam wand, hands tamping, morning kitchen, logo) → Higgsfield at its best model, 1080p, 24 fps, same kitchen and lighting words in every shot → assemble with narration, music and captions → review, regenerate the one warped hand shot → upload to Vimeo with title, description and a thumbnail → the link in the chat.

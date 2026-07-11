🎛️ Wavmind

An AI music production agent that lives inside Slack.

Wavmind brings real audio analysis, AI mix feedback, sample discovery, DAW tutoring, and project tracking directly into the workspace producers already use to collaborate. No new app to learn — just talk to it or tap a button.

Built for Slack Hackathon 2026.


Why Wavmind

Most AI music tools ask a language model to guess what a track sounds like. Wavmind measures it.

Uploaded audio runs through real digital signal processing, producing actual LUFS loudness, stereo width, frequency balance, and vocal clarity. The AI layer then interprets real numbers, not estimates — so feedback and comparisons are grounded in what the audio actually contains, not what an LLM imagines.


Features

CategoryWhat it does🎧 Audio scanUpload any MP3/WAV → real LUFS, stereo width, low/mid/high balance, vocal clarity🆚 CompareUpload your track + a reference → measured gap report with AI fixes🎚️ Mix feedbackAI feedback grounded in your actual scan data — never asks for BPM/key🎵 SamplesSearch 500K+ Creative Commons sounds, different results every search🔍 Reference lookupReal track metadata + AI production blueprint for any song🎤 Artist compareSide-by-side production style comparison for any two artists🎸 DAW helpStep-by-step tutorials for 9 DAWs, powered by live web search + AI🎓 DAW GuruPersonalized daily lessons based on your DAW, skill level, and focus area🆕 New releasesFresh new-music picks by genre, rotates on every fetch📌 Project trackerTrack in-progress tracks with daily reminders until marked done🤝 Team collabShared-channel sessions to log ideas, notes, and decisions with an AI summary🗣️ Natural languageNo commands required — plain sentences route to the right feature🤖 Autonomous follow-ups24hr check-ins after uploads, daily lessons, weekly digests — all unprompted🔌 MCP supportThe same tools are also reachable from Claude Desktop and other MCP clients


How it works (high level)

Wavmind runs as a Slack app connected in real time, paired with a dedicated audio-analysis service for measuring uploaded tracks. An AI layer interprets those measurements into actionable feedback, while a background scheduler drives the app's autonomous behaviors — check-ins, daily lessons, and weekly reports — without any user prompting.

The same core capabilities are also exposed through the Model Context Protocol, so they're usable from AI clients beyond Slack.

Full architecture and implementation details are available to hackathon judges on request.


Tech stack

Node.js · Slack Bolt.js · Python audio processing (librosa, pyloudnorm) · Groq (Llama) · Spotify · Freesound · Tavily · Railway · Model Context Protocol


Try it


Demo video: see submission
Live app: connect via Slack (contact for workspace access during judging)



Known limitations


Demo storage is ephemeral by design and resets periodically — a production version would use persistent database storage.
Some production-style stats (BPM, key, energy) in track/artist comparisons are AI-estimated from real metadata, since the underlying audio-features API this relied on was deprecated mid-build. Core track metadata (popularity, release date, genre) is always real.



What's next


Persistent database storage
Direct BPM/key detection from uploaded audio
Reference tracks via URL instead of file upload
Team analytics dashboards
Additional platform integrations



License

All Rights Reserved. This repository is public for hackathon evaluation purposes only. See LICENSE for details — no reuse permitted without explicit permission.

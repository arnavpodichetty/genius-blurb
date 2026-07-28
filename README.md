# Genius Blurb
A Spicetify extension that brings Genius annotations into Spotify — song backstories, "about this song" descriptions, and line-by-line lyric annotations that sync with playback.

## Features
- **Song descriptions** — Pulls the "About" section from Genius for the currently playing track
- **Live lyric annotations** — As synced lyrics play, matches the current line to its Genius annotation and displays it in real time
- **Song facts** — Album, release date, producers, writers, and streaming links
- **Samples & interpolations** — Shows related songs (samples, covers, remixes, interpolations) in a collapsible section
- **Local caching** — Song data is cached so repeat plays load instantly
- **No hardcoded secrets** — You provide your own free Genius API token, stored locally

## Installation

### Option 1: Spicetify Marketplace (recommended)
1. Open Spotify and go to the **Marketplace** tab in the sidebar.
2. Search for **"Genius Blurb"**.
3. Click **Install**.

### Option 2: Manual installation
1. Copy the extension into your Spicetify extensions folder:
   ```bash
   cp geniusBlurb.js ~/.config/spicetify/Extensions/
   ```
2. Enable and apply it:
   ```bash
   spicetify config extensions geniusBlurb.js
   spicetify apply
   ```

## Setup
1. Click the **✦ Genius** button in the bottom-right corner of Spotify.
2. You'll be prompted for a Genius API access token. Create a free one at [genius.com/api-clients](https://genius.com/api-clients).
3. Paste the token in and hit **Save** — it's stored locally and never leaves your machine.

## Usage
- Click **✦ Genius** to open the panel for the currently playing song.
- Click **✕** to close it.
- The panel updates automatically as you change tracks.
- If the song has synced lyrics, the current line's annotation (if one exists) appears at the top of the panel while it plays.

## Notes
- Not every song has a Genius page, description, or annotations — the panel will let you know when nothing is available.
- Live line annotations require Spotify's synced ("line-synced") lyrics to be available for the track.
- Per-line annotation matching uses word overlap rather than exact text, since Genius fragments and Spotify's lyric lines don't always align 1:1.
- This is an unofficial, community-built extension and is not affiliated with Spotify or Genius.

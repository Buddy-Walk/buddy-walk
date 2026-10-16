"""Generate BUDDY_WALK_USER_TESTING_SLIDES.pptx for beta / user-testing presentations.

Run:  python generate_user_testing_slides.py
Requires: python-pptx  (pip install python-pptx)
"""

from pptx import Presentation
from pptx.util import Inches, Pt

from generate_slides import (
    WIDE_H,
    WIDE_W,
    content_slide,
    title_slide,
)

WEB_URL = "https://buddywalk.app"


# Assemble the user-testing presentation with the shared slide helpers and save the widescreen
# deck.
def build():
    prs = Presentation()
    prs.slide_width = WIDE_W
    prs.slide_height = WIDE_H

    title_slide(
        prs,
        "Buddy Walk",
        "User Testing Guide",
        "Accessibility-first navigation for blind & low-vision travelers",
    )

    content_slide(prs, "What We're Testing", [
        (0, "Buddy Walk combines **camera + voice Q&A**, **spoken answers**, and **hands-off turn-by-turn guidance** (haptics on native iOS).", ""),
        (0, "This round focuses on **real-world usability** — especially by ear and touch, with VoiceOver where possible.", ""),
        (0, "Run **each test category 5 times** — different storefronts, destinations, or lines each run.", "good"),
        (0, "Auth is **bypassed** for this beta: after permissions, you land on the main screen. No sign-in required.", ""),
    ])

    content_slide(prs, "How to Access the Beta", [
        (0, "**Web beta (available now)**", "good"),
        (1, WEB_URL, ""),
        (1, "Open in **Safari (iPhone)** or **Chrome** — allow camera, mic, and location when prompted.", ""),
        (0, "**iOS app (TestFlight)**", ""),
        (1, "Install via TestFlight when your build is approved in App Store Connect.", ""),
        (1, "Native app = full **haptic navigation** and **shake-to-stop**.", ""),
        (0, "**Tip:** hard-refresh the web page if you tested an older build (Ctrl+Shift+R / pull-to-refresh).", "muted"),
    ])

    content_slide(prs, "Before You Start", [
        (0, "Complete the **permissions screen**: location, camera, and microphone — all three are required.", ""),
        (0, "Use **headphones** or turn volume up so spoken answers are easy to hear.", ""),
        (0, "For the fairest location test, use a **phone browser** (real GPS), not a desktop on campus Wi‑Fi.", ""),
        (0, "If you hear *\"Your location looks approximate\"*, nearby results may be off — try again on a phone.", "muted"),
    ])

    content_slide(prs, "Test 1 — Camera + Voice Q&A", [
        (0, "**Goal:** confirm capture, questions, and spoken answers work end-to-end.", "good"),
        (0, "Point the camera at your surroundings.", ""),
        (1, "**Tap quickly** on the camera area → photo captured (you'll hear confirmation).", ""),
        (1, "**Hold** the camera area → video mode (web samples frames; native records video).", ""),
        (0, "Ask a question:", ""),
        (1, "Tap **Tap to Ask** and speak, **or** type in the text field.", ""),
        (1, "Tap **Submit**.", ""),
        (0, "**Pass if:** the answer is **accurate**, **spoken once**, and **easy to hear**.", "good"),
    ])

    content_slide(prs, "Test 2 — Hands-Off Navigation", [
        (0, "**Goal:** directions start automatically — no extra buttons.", "good"),
        (0, 'Ask: *"How do I get to [a nearby place]?"* (e.g. a café, station, or landmark).', ""),
        (0, "**Native (TestFlight / Expo Go):**", ""),
        (1, "Navigation **starts automatically** — vibrations + spoken turn-by-turn.", ""),
        (1, "Steps advance **as you walk** (GPS) or on a timer when GPS points are missing.", ""),
        (1, 'Near the destination: hear **"You have arrived."**', ""),
        (1, '**Shake the phone** to stop → buzz + "Navigation stopped."', ""),
        (0, "**Web:** voice directions work; **haptics and shake-to-stop are native-only.** Use **Stop Navigation** on screen.", "muted"),
    ])

    content_slide(prs, "Test 3 — VoiceOver & Accessibility", [
        (0, "**Goal:** the whole flow works with the screen reader on.", "good"),
        (0, "Turn on **VoiceOver** (Settings → Accessibility → VoiceOver).", ""),
        (0, "Run Tests 1 and 2 again:", ""),
        (1, "Buttons and status should be **announced** clearly.", ""),
        (1, "Arrival and off-route warnings should use **assertive** announcements.", ""),
        (1, "You should **not** hear the same text twice (app TTS + VoiceOver overlapping).", ""),
        (0, "**Pass if:** you can complete the flow **without seeing the screen.**", "good"),
    ])

    content_slide(prs, "Test 4 — Companion Mode", [
        (0, "**Goal:** generate a live location share link for a trusted contact.", "good"),
        (0, "From the main screen, open **Companion Mode**.", ""),
        (0, "**Pass if:**", ""),
        (1, "A **share link** is created successfully.", ""),
        (1, "Your contact can open it and see **live location updates** (same Wi‑Fi / network as backend).", ""),
        (0, "Report if the link fails to load or location doesn't update.", "muted"),
    ])

    content_slide(prs, "Test 5 — Saved Places", [
        (0, "**Goal:** save addresses and use them in natural-language questions.", "good"),
        (0, "Open **Saved Places** and save a location (e.g. alias **home**).", ""),
        (0, 'Return to main and ask: *"How do I get home?"*', ""),
        (0, "**Pass if:**", ""),
        (1, "The app resolves your saved alias.", ""),
        (1, "You get **directions** (and auto-navigation on native).", ""),
    ])

    content_slide(prs, "What to Report", [
        (0, "Anything that **doesn't speak or vibrate** when you expect it to.", ""),
        (0, "**Wrong or vague directions** — especially if GPS seemed fine.", ""),
        (0, "**Accidental navigation stops** while walking (native shake sensitivity).", ""),
        (0, "**VoiceOver** issues: missed labels, double speech, unreachable controls.", ""),
        (0, "**Web-only:** white screen, photo errors, bad location on desktop.", ""),
        (0, "Include: device (iPhone model / browser), what you asked, and what happened.", "muted"),
    ])

    content_slide(prs, "Quick Reference", [
        (0, "**Web beta:**", "good"),
        (1, WEB_URL, ""),
        (0, "**Camera:** tap = photo, hold = video", ""),
        (0, "**Directions:** ask naturally → navigation auto-starts (native)", ""),
        (0, "**Stop navigation:** shake phone (native) or Stop button (web)", ""),
        (0, "**Feedback:** raymondsekyere99@gmail.com, dylansch7@gmail.com", "muted"),
    ])

    content_slide(prs, "Thank You", [
        (0, "Your feedback directly shapes Buddy Walk for blind and low-vision travelers.", ""),
        (0, f"Try the beta: **{WEB_URL}**", "good"),
        (0, "Questions & discussion.", "muted"),
    ])

    out = "BUDDY_WALK_USER_TESTING_SLIDES.pptx"
    prs.save(out)
    print(f"Wrote {out} with {len(prs.slides._sldIdLst)} slides")


if __name__ == "__main__":
    build()

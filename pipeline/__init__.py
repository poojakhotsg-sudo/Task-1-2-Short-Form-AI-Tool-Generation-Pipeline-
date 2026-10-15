"""
reel-pipeline: turn an AI tool's website into short vertical reel clips.

Stages: script_gen -> grabber -> qa -> trial_recorder -> assembler -> drive_upload

PROJECT RULE: no module may read, store, log, or ask for card details or passwords.
Trial sign-ups and any payment step are done by a person in a visible browser;
the code only ever sees the resulting session cookies (auth_<tool>.json, git-ignored).
"""

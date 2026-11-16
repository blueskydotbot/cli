import os
import random
import re
from pathlib import Path
from atproto import Client, client_utils
from self_label import ensure_self_label
from reply_to_mentions import reply_to_mentions


def rich_text(text):
    builder, offset = client_utils.TextBuilder(), 0
    for match in re.finditer(r"https?://[^\s]+|(?<!\w)#[\w]+", text):
        builder.text(text[offset:match.start()])
        value = match.group()
        if value.startswith("#"):
            builder.tag(value, value[1:])
        else:
            builder.link(value, value)
        offset = match.end()
    return builder.text(text[offset:])


def run_bot(env=None, client=None, lines=None):
    env = os.environ if env is None else env
    lines = [line for line in (Path(__file__).parent / "posts.txt").read_text().splitlines() if line.strip()] if lines is None else lines
    if env.get("DRY_RUN") != "false":
        print("Dry run: one scheduled text; replies disabled.")
        print(lines[0] if lines else "Nothing to post.")
        return
    if not env.get("BLUESKY_HANDLE") or not env.get("BLUESKY_APP_PASSWORD"):
        raise ValueError("Set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD repository secrets.")
    client = client or Client(base_url=env.get("BLUESKY_SERVICE", "https://bsky.social"))
    client.login(env["BLUESKY_HANDLE"], env["BLUESKY_APP_PASSWORD"])
    if env.get("SET_SELF_LABEL") != "false":
        ensure_self_label(client)
    recent = {getattr(item.post.record, "text", None) if not isinstance(item.post.record, dict) else item.post.record.get("text") for item in client.get_author_feed(client.me.did, limit=25).feed}
    options = [line for line in lines if line not in recent]
    random.shuffle(options)
    for text in options[:min(5, max(0, int(env.get("MAX_POSTS_PER_RUN", "1"))))]:
        # A conservative code-point cap also guarantees at most 300 graphemes.
        if len(text) <= 300 and len(text.encode("utf8")) <= 3000:
            client.send_post(rich_text(text))
    if env.get("REPLY_TO_MENTIONS") == "true":
        reply_to_mentions(client, int(env.get("MAX_REPLIES_PER_RUN", "5")), dry_run=False)


if __name__ == "__main__":
    try:
        run_bot()
    except Exception as error:
        response = getattr(error, "response", None)
        if getattr(response, "status_code", None) == 429:
            print("Rate limited. Wait until:", getattr(response, "headers", {}).get("ratelimit-reset", "the server's reset time"))
        else:
            print("The bot stopped. Check the account and service before running again.")
        raise SystemExit(1) from None

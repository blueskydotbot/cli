# Replies are opt-in. Call after signing in once as the bot.
from datetime import datetime, timezone
from atproto import models


def reply_to_mentions(client, max_replies=5, dry_run=True):
    # Capture the watermark before reading so newer notifications stay unread.
    seen_at = datetime.now(timezone.utc).isoformat()
    notifications = client.app.bsky.notification.list_notifications({"limit": 100}).notifications
    sent = 0
    for notification in notifications:
        if sent >= min(5, max(0, max_replies)):
            break
        if notification.is_read or notification.reason not in ("mention", "reply") or notification.author.did == client.me.did:
            continue
        profile = client.get_profile(notification.author.did)
        labels = profile.labels or []
        viewer = profile.viewer
        if (viewer and (viewer.blocked_by or viewer.blocking or viewer.muted)) or any(label.val == "bot" and label.src == profile.did and label.uri == f"at://{profile.did}/app.bsky.actor.profile/self" and not label.neg for label in labels):
            continue
        raw = notification.record
        record = raw if isinstance(raw, dict) else raw.model_dump(mode="json", by_alias=True, exclude_unset=True)
        if record.get("$type") != "app.bsky.feed.post":
            continue
        parent = {"uri": notification.uri, "cid": notification.cid}
        root = record.get("reply", {}).get("root", parent)
        if not isinstance(root, dict) or not isinstance(root.get("uri"), str) or not isinstance(root.get("cid"), str):
            root = parent
        # Never retry a failed write here: the caller stops on 429 or any error.
        if not dry_run:
            client.send_post("Thanks for asking! 🤖", reply_to=models.AppBskyFeedPost.ReplyRef(root=models.ComAtprotoRepoStrongRef.Main(**root), parent=models.ComAtprotoRepoStrongRef.Main(**parent)))
        sent += 1
    if not dry_run:
        client.app.bsky.notification.update_seen({"seen_at": seen_at})
    return sent

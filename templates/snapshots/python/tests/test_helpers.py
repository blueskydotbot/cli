import copy
import json
import unittest
from types import SimpleNamespace as NS
from self_label import ensure_self_label
from reply_to_mentions import reply_to_mentions

DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz"


class ApiError(Exception):
    def __init__(self, code):
        self.response = NS(content={"error": code})


class Fake:
    def __init__(self, record=None, notifications=None):
        self.record = record or {}
        self.writes, self.posts, self.seen, self.profiles = [], [], [], []
        self.me = NS(did=DID)
        self.com = NS(atproto=NS(repo=NS(get_record=self.get_record)))
        self.app = NS(bsky=NS(notification=NS(list_notifications=lambda params: NS(notifications=notifications or []), update_seen=lambda data: self.seen.append(data))))

    def get_record(self, params):
        return NS(value=copy.deepcopy(self.record), cid="cid-before")

    def invoke_procedure(self, method, data, **kwargs):
        self.writes.append(json.loads(data))

    def get_profile(self, actor):
        self.profiles.append(actor)
        label = NS(val="bot", src=actor, uri=f"at://{actor}/app.bsky.actor.profile/self", neg=False)
        return NS(did=actor, labels=[label] if actor.endswith("automated") else [], viewer=None)

    def send_post(self, text, reply_to=None):
        self.posts.append((text, reply_to))


def notice(author, **patch):
    return NS(**{"author": NS(did=author), "reason": "mention", "is_read": False, "uri": f"at://{author}/app.bsky.feed.post/3k3akefak3k2k", "cid": "bafyreicjxzvqnhmst6x5lnvsdqjwi2xi7aowpk7j2n3mghjphbms5n2tvy", "record": {"$type": "app.bsky.feed.post"}, **patch})


class Helpers(unittest.TestCase):
    def test_preserves_profile_and_is_idempotent(self):
        record = {"displayName": "Keep", "extension": {"data": 1}, "labels": {"$type": "com.atproto.label.defs#selfLabels", "values": [{"val": "graphic-media"}]}}
        client = Fake(record)
        self.assertTrue(ensure_self_label(client))
        self.assertEqual(client.writes[0]["swapRecord"], "cid-before")
        self.assertEqual(client.writes[0]["record"]["extension"], record["extension"])
        self.assertEqual(client.writes[0]["record"]["labels"]["values"], [{"val": "graphic-media"}, {"val": "bot"}])
        already = Fake(client.writes[0]["record"])
        self.assertFalse(ensure_self_label(already))
        self.assertEqual(already.writes, [])

    def test_missing_profile_keeps_explicit_null_and_conflicts_retry_once(self):
        client = Fake()
        client.com.atproto.repo.get_record = lambda params: (_ for _ in ()).throw(ApiError("RecordNotFound"))
        ensure_self_label(client)
        self.assertIsNone(client.writes[0]["swapRecord"])
        client = Fake()
        original = client.invoke_procedure
        calls = []
        def conflict(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                client.record = {"displayName": "New"}
                raise ApiError("InvalidSwap")
            original(*args, **kwargs)
        client.invoke_procedure = conflict
        ensure_self_label(client)
        self.assertEqual(len(calls), 2)
        self.assertEqual(client.writes[0]["record"]["displayName"], "New")

    def test_unknown_labels_refused_and_dry_run_never_writes(self):
        with self.assertRaises(ValueError):
            ensure_self_label(Fake({"labels": {"$type": "unknown"}}))
        dry = Fake()
        self.assertTrue(ensure_self_label(dry, True))
        self.assertEqual(dry.writes, [])

    def test_replies_filter_loop_guard_cap_and_preserve_root(self):
        root = {"uri": f"at://{DID}/app.bsky.feed.post/3k3akefak3k2k", "cid": "bafyreicjxzvqnhmst6x5lnvsdqjwi2xi7aowpk7j2n3mghjphbms5n2tvy"}
        notifications = [notice("did:plc:read", is_read=True), notice("did:plc:like", reason="like"), notice(DID), notice("did:plc:automated"), notice("did:plc:human", record={"$type": "app.bsky.feed.post", "reply": {"root": root}}), notice("did:plc:second")]
        client = Fake(notifications=notifications)
        self.assertEqual(reply_to_mentions(client, 1, False), 1)
        self.assertEqual(client.posts[0][1].root.uri, root["uri"])
        self.assertEqual(client.posts[0][1].parent.uri, notifications[4].uri)
        self.assertEqual(len(client.seen), 1)
        dry = Fake(notifications=[notice("did:plc:human")])
        self.assertEqual(reply_to_mentions(dry), 1)
        self.assertEqual(dry.posts + dry.seen, [])

    def test_failed_write_stops_without_retry(self):
        client = Fake(notifications=[notice("did:plc:one"), notice("did:plc:two")])
        client.send_post = lambda *args, **kwargs: (_ for _ in ()).throw(ApiError("RateLimitExceeded"))
        with self.assertRaises(ApiError):
            reply_to_mentions(client, dry_run=False)
        self.assertEqual(len(client.profiles), 1)
        self.assertEqual(client.seen, [])

# Call after signing in once as the bot; keep every other profile field.
import copy
import json


def error_code(error):
    content = getattr(getattr(error, "response", None), "content", None)
    return content.get("error") if isinstance(content, dict) else getattr(content, "error", None)


def ensure_self_label(client, dry_run=False):
    repo = client.me.did
    for attempt in range(2):
        record, cid = {}, None
        try:
            response = client.com.atproto.repo.get_record({"repo": repo, "collection": "app.bsky.actor.profile", "rkey": "self"})
            value = response.value
            record = copy.deepcopy(value if isinstance(value, dict) else value.model_dump(mode="json", by_alias=True, exclude_unset=True))
            cid = response.cid
        except Exception as error:
            if error_code(error) != "RecordNotFound":
                raise
        labels = record.get("labels")
        if labels is not None and (not isinstance(labels, dict) or labels.get("$type") != "com.atproto.label.defs#selfLabels" or not isinstance(labels.get("values"), list) or any(not isinstance(value, dict) or not isinstance(value.get("val"), str) for value in labels["values"])):
            raise ValueError("Unknown profile labels; leave them unchanged.")
        values = (labels or {}).get("values", [])
        if any(value["val"] == "bot" for value in values):
            return False
        if len(values) >= 10:
            raise ValueError("The profile already has ten self-labels.")
        if dry_run:
            return True
        updated = {**record, "$type": "app.bsky.actor.profile", "labels": {**(labels or {}), "$type": "com.atproto.label.defs#selfLabels", "values": values + [{"val": "bot"}]}}
        try:
            # Raw JSON preserves the null compare-and-swap on a missing profile.
            client.invoke_procedure("com.atproto.repo.putRecord", data=json.dumps({"repo": repo, "collection": "app.bsky.actor.profile", "rkey": "self", "swapRecord": cid, "record": updated}).encode(), input_encoding="application/json", output_encoding="application/json")
            return True
        except Exception as error:
            # Re-read once on a concurrent profile edit; never overwrite blindly.
            if error_code(error) != "InvalidSwap" or attempt == 1:
                raise
    return False

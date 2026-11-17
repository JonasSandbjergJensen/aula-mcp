"""Personal reading state, restart durability and authenticated HTTP boundaries."""
import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest

from test_analysis import FakeStore, analysis, result


class InboxTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.manager = analysis.AulaAnalysis(types.SimpleNamespace(), types.SimpleNamespace(api=None), "test")
        self.manager.data["records"] = {"revision-1": {
            "source_id": "aula-post-1", "state": "ok", "test": False,
            "created": "2026-01-01T12:00:00+00:00", "result": result(),
        }}

    async def test_read_and_archive_are_independent_and_survive_restart(self):
        await self.manager.inbox_update("user-a", "revision-1", "read")
        await self.manager.inbox_update("user-a", "revision-1", "archive")
        self.assertTrue(self.manager.inbox("user-a")["items"][0]["archived"])
        self.assertEqual(self.manager.inbox("user-a")["unread"], 0)
        self.assertEqual(self.manager.inbox("user-b")["unread"], 1)
        self.assertFalse(self.manager.inbox("user-b")["items"][0]["read"])
        restored = analysis.AulaAnalysis(types.SimpleNamespace(), types.SimpleNamespace(api=None), "test")
        restored.data.update(await self.manager.store.async_load())
        self.assertTrue(restored.inbox("user-a")["items"][0]["archived"])
        self.assertEqual(restored.inbox("user-b")["unread"], 1)
        await restored.inbox_update("user-a", "revision-1", "restore")
        await restored.inbox_update("user-a", "revision-1", "unread")
        self.assertEqual(restored.inbox("user-a")["unread"], 1)

    async def test_concurrent_users_cannot_overwrite_each_other(self):
        await asyncio.gather(self.manager.inbox_update("user-a", "revision-1", "read"),
                             self.manager.inbox_update("user-b", "revision-1", "archive"))
        self.assertFalse(self.manager.inbox("user-a")["items"][0]["archived"])
        self.assertFalse(self.manager.inbox("user-b")["items"][0]["read"])

    async def test_failed_save_does_not_remove_item_in_memory(self):
        async def fail():
            raise OSError("disk unavailable")
        self.manager.save = fail
        with self.assertRaises(OSError):
            await self.manager.inbox_update("user-a", "revision-1", "archive")
        self.assertEqual(self.manager.inbox("user-a")["unread"], 1)
        self.assertFalse(self.manager.inbox("user-a")["items"][0]["archived"])

    async def test_new_revision_is_unread_for_both_and_test_cannot_replace_real(self):
        await self.manager.inbox_update("user-a", "revision-1", "archive")
        await self.manager.inbox_update("user-b", "revision-1", "read")
        old = self.manager.data["records"]["revision-1"]
        old["superseded"] = True
        new = copy.deepcopy(old)
        new.update(superseded=False, created="2026-01-02T12:00:00+00:00")
        self.manager.data["records"]["revision-2"] = new
        test = copy.deepcopy(new)
        test.update(test=True, created="2026-01-03T12:00:00+00:00")
        self.manager.data["records"]["test"] = test
        for user in ("user-a", "user-b"):
            inbox = self.manager.inbox(user)
            self.assertEqual(inbox["unread"], 1)
            self.assertEqual([x["id"] for x in inbox["items"]], ["revision-2"])

    async def test_invalid_actions_and_hidden_items_cannot_be_changed(self):
        for user in (None, ""):
            with self.assertRaises(ValueError):
                self.manager.inbox(user)
        with self.assertRaises(ValueError):
            await self.manager.inbox_update("a", "revision-1", "delete")
        with self.assertRaises(KeyError):
            await self.manager.inbox_update("a", "missing", "read")
        self.manager.data["records"]["revision-1"]["result"]["relevance"] = "none"
        self.assertFalse(self.manager.inbox("a")["items"])
        with self.assertRaises(KeyError):
            await self.manager.inbox_update("a", "revision-1", "archive")

    def test_response_does_not_expose_other_users_or_local_config(self):
        self.manager.data["config"] = {"private": "must-not-leak"}
        self.manager.data["inbox_users"] = {"other-user-secret": {"revision-1": {"read_at": "yesterday"}}}
        response = self.manager.inbox("a")
        text = json.dumps(response)
        self.assertNotIn("must-not-leak", text)
        self.assertNotIn("other-user-secret", text)
        response["items"][0]["result"]["summary"] = "modified"
        self.assertNotEqual(self.manager.data["records"]["revision-1"]["result"]["summary"], "modified")


# Import just the actual HTTP view classes without emulating the integration.
import ast
source = Path(__file__).parent.parent / "custom_components/aula_bridge/__init__.py"
tree = ast.parse(source.read_text())
view_tree = ast.Module(body=[node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "AulaInboxView"], type_ignores=[])


class StubView:
    def json(self, data, status_code=200, headers=None):
        return types.SimpleNamespace(data=data, status=status_code, headers=headers)


scope = {"HomeAssistantView": StubView, "KEY_HASS": "hass", "DOMAIN": "aula_bridge"}
exec(compile(view_tree, str(source), "exec"), scope)


class Request(dict):
    def __init__(self, manager, user, body=None):
        super().__init__()
        if user is not None:
            self["hass_user"] = types.SimpleNamespace(id=user)
        self.app = {"hass": types.SimpleNamespace(data={"aula_bridge": {"entry": types.SimpleNamespace(analysis=manager)}})}
        self.body = body

    async def json(self):
        return self.body


class InboxViewTests(unittest.IsolatedAsyncioTestCase):
    setUp = InboxTests.setUp
    async def test_http_requires_auth_and_uses_current_user_only(self):
        view = scope["AulaInboxView"]()
        self.assertTrue(view.requires_auth)
        self.assertEqual((await view.get(Request(self.manager, None))).status, 401)
        self.assertEqual((await view.post(Request(self.manager, None))).status, 401)
        forged = {"id": "revision-1", "action": "archive", "user_id": "user-b"}
        self.assertEqual((await view.post(Request(self.manager, "user-a", forged))).status, 400)
        response = await view.post(Request(self.manager, "user-a", {"id": "revision-1", "action": "archive"}))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        other = await view.get(Request(self.manager, "user-b"))
        self.assertEqual(other.data["unread"], 1)
        self.assertFalse(other.data["items"][0]["archived"])


if __name__ == "__main__":
    unittest.main()

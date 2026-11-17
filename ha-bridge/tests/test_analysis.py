"""Synthetic tests for the durable analysis queue; no live family data."""
import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest

for name in ("homeassistant", "homeassistant.helpers", "homeassistant.helpers.storage",
             "homeassistant.helpers.event", "homeassistant.exceptions"):
    sys.modules.setdefault(name, types.ModuleType(name))


class FakeStore:
    def __init__(self, *args):
        self.saved = None

    async def async_load(self):
        return copy.deepcopy(self.saved)

    async def async_save(self, data):
        self.saved = copy.deepcopy(data)


sys.modules["homeassistant.helpers.storage"].Store = FakeStore
sys.modules["homeassistant.helpers.event"].async_track_time_interval = lambda *args: lambda: None
sys.modules["homeassistant.exceptions"].HomeAssistantError = type("HomeAssistantError", (Exception,), {})
spec = importlib.util.spec_from_file_location("analysis", Path(__file__).parent.parent / "custom_components/aula_bridge/analysis.py")
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


def result(source_id="aula-post-1", **changes):
    value = {"status": "ok", "relevance": "action", "title": "Husk en taske",
             "notification": "Medbring en taske i morgen.", "summary": "Kilden beder om en taske.",
             "actions": [{"text": "Medbring en taske", "deadline": None}],
             "uncertainties": [], "source_ids": [source_id]}
    value.update(changes)
    return value


TEST_PHONES = ("mobile_app_test_a", "mobile_app_test_b")
TEST_CONFIG = {"child_name":"Testbarn", "class_label":"1.A", "year_label":"1. årgang", "school_name":"Testskolen", "school_year":"2026/27", "institution_code":"123", "phone_services":list(TEST_PHONES), "guardian_ids":[1234]}


class FakeApi:
    def __init__(self):
        self.calls = []
        self.posts = [{"id": 1, "title": "Taske", "date": analysis.now_iso(),
                       "institution": "Testskolen", "content": "Medbring en taske i morgen."}]
        self.thread = {"messages": [{"id": "m1", "sendDateTime": analysis.now_iso(),
                                     "text": {"html": "<p>Husk en taske</p>"}, "attachments": []}]}
        self.fail = False

    async def call(self, name, arguments):
        self.calls.append((name, arguments))
        if self.fail:
            raise RuntimeError("offline")
        if name == "aula.posts.list":
            return {"posts": copy.deepcopy(self.posts), "moreMessagesExist": False}
        if name == "aula.messages.list_threads":
            return {"threads": [], "hasMorePages": False}
        if name == "aula.messages.get_thread":
            return self.thread if arguments.get("page", 0) == 0 else {"messages": []}
        if name.endswith("get_attachment"):
            return {"attachment_id": "id"}
        if name == "aula.utils.extract_pdf_text":
            return {"ok": True, "text": "PDF-tekst"}
        raise AssertionError(name)


class FakeBus:
    def __init__(self):
        self.listeners = {}

    def async_listen(self, name, callback):
        self.listeners[name] = callback
        return lambda: self.listeners.pop(name, None)


class FakeServices:
    def __init__(self, hass):
        self.hass = hass
        self.calls = []
        self.response = result()
        self.error_phone = None

    async def async_call(self, domain, service, data, blocking):
        self.calls.append((domain, service, copy.deepcopy(data)))
        if domain == "openclaw":
            raw = self.response if isinstance(self.response, str) else json.dumps(self.response)
            await self.hass.bus.listeners["openclaw_message_received"](types.SimpleNamespace(data={
                "session_id": data["session_id"], "message": raw}))
        if service == self.error_phone:
            raise RuntimeError("phone offline")


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hass = types.SimpleNamespace(bus=FakeBus(), async_create_task=asyncio.create_task)
        self.hass.services = FakeServices(self.hass)
        self.api = FakeApi()
        self.manager = analysis.AulaAnalysis(self.hass, types.SimpleNamespace(api=self.api), "test")
        await self.manager.start()
        self.manager.data["since"] = "2020-01-01T00:00:00+00:00"
        await self.manager.control(True, copy.deepcopy(TEST_CONFIG))

    def calls(self, domain):
        return [c for c in self.hass.services.calls if c[0] == domain]

    async def test_valid_result_and_duplicate_do_not_repeat_model_or_push(self):
        await self.manager.scan()
        await self.manager.scan()
        self.assertEqual(len(self.calls("openclaw")), 1)
        self.assertEqual(len(self.calls("notify")), 2)
        self.assertEqual(len(self.manager.data["records"]), 1)

    async def test_revision_is_processed_but_expiring_url_is_ignored(self):
        item = self.api.posts[0]
        item["attachments"] = [{"name": "brev.pdf", "url": "https://example.test/a?expires=1"}]
        await self.manager.scan()
        item["attachments"][0]["url"] = "https://example.test/a?expires=2"
        await self.manager.scan()
        self.assertEqual(len(self.calls("openclaw")), 1)
        item["content"] = "Medbring to tasker"
        await self.manager.scan()
        self.assertEqual(len(self.calls("openclaw")), 2)

    async def test_response_before_service_returns_is_captured(self):
        await self.manager.scan()
        record = next(iter(self.manager.data["records"].values()))
        self.assertEqual(record["state"], "ok")
        self.assertFalse(self.manager.waiters)

    async def test_invalid_json_only_sends_generic_review_notice(self):
        self.hass.services.response = "Det skal I huske!"
        await self.manager.scan()
        self.assertEqual(next(iter(self.manager.data["records"].values()))["state"], "needs_review")
        self.assertEqual(len(self.calls("notify")), 2)
        self.assertNotIn("taske", self.calls("notify")[0][2]["message"])

    async def test_wrong_source_only_sends_generic_review_notice(self):
        self.hass.services.response = result(source_id="aula-post-999")
        await self.manager.scan()
        self.assertEqual(len(self.calls("notify")), 2)
        self.assertNotIn("taske", self.calls("notify")[0][2]["message"])

    async def test_unsupported_attachment_forces_review(self):
        self.api.posts[0]["attachments"] = [{"name": "brev.docx", "url": "https://example.test/secret"}]
        await self.manager.scan()
        self.assertEqual(len(self.calls("notify")), 2)
        self.assertNotIn("taske", self.calls("notify")[0][2]["message"])
        record = next(iter(self.manager.data["records"].values()))
        self.assertEqual(record["state"], "needs_review")
        self.assertNotIn("https://example.test/secret", self.calls("openclaw")[0][2]["message"])

    async def test_pdf_is_extracted_before_model_call(self):
        self.api.posts[0]["attachments"] = [{"name": "brev.pdf", "url": "https://example.test/secret"}]
        await self.manager.scan()
        sent = self.calls("openclaw")[0][2]["message"]
        self.assertIn("PDF-tekst", sent)
        self.assertNotIn("https://example.test/secret", sent)

    async def test_test_source_never_sends_phone_push(self):
        await self.manager.test_source("post", 1)
        self.assertFalse(self.calls("notify"))
        self.assertEqual(len(self.calls("openclaw")), 1)

    async def test_source_error_is_visible(self):
        self.api.fail = True
        status = await self.manager.scan()
        self.assertEqual(status["error"], "RuntimeError")
        self.assertFalse(self.calls("notify"))
        self.assertTrue(self.calls("persistent_notification"))

    async def test_private_thread_has_generic_push(self):
        self.hass.services.response = result(source_id="aula-thread-2", title="Privat detalje", notification="Privat indhold")
        await self.manager.process("thread", {"id": 2, "extraRecipientsCount": 2, "subject": "Kontaktbog", "latestMessage": {"id": "m1"}})
        for _, _, data in self.calls("notify"):
            self.assertNotIn("Privat indhold", data["message"])
            self.assertIn("personlig besked", data["message"])

    async def test_restart_marks_interrupted_job_and_preserves_disable(self):
        self.manager.data["records"]["interrupted"] = {"source_id": "aula-post-99", "state": "processing", "test": False}
        await self.manager.control(False)
        await self.manager.start()
        self.assertFalse(self.manager.data["enabled"])
        self.assertEqual(self.manager.data["records"]["interrupted"]["state"], "needs_review")

    async def test_one_failed_phone_does_not_block_other(self):
        self.hass.services.error_phone = TEST_PHONES[0]
        await self.manager.scan()
        self.assertEqual(len(self.calls("notify")), 2)
        record = next(iter(self.manager.data["records"].values()))
        self.assertEqual(record["delivery_errors"], [TEST_PHONES[0]])

    async def test_none_is_silent(self):
        self.hass.services.response = result(relevance="none", actions=[], notification="")
        await self.manager.scan()
        self.assertFalse(self.calls("notify"))
        self.assertFalse(self.calls("persistent_notification"))

    async def test_disabled_processing_does_not_push(self):
        await self.manager.control(False)
        await self.manager.process("post", self.api.posts[0])
        self.assertFalse(self.calls("notify"))

    async def test_identical_result_of_new_revision_does_not_repeat_push(self):
        await self.manager.scan()
        self.api.posts[0]["content"] += " Tak."
        await self.manager.scan()
        self.assertEqual(len(self.calls("openclaw")), 2)
        self.assertEqual(len(self.calls("notify")), 2)

    async def test_system_messages_with_null_attachments_are_ignored(self):
        self.api.thread["messages"].insert(0, {"id": "system", "text": None, "attachments": None})
        source = await self.manager.source("thread", {"id": 2, "subject": "Test"})
        self.assertEqual(len(source["messages"]), 1)
        pages = [args["page"] for name, args in self.api.calls if name.endswith("get_thread")]
        self.assertEqual(pages, [0, 1])


class ResultTests(unittest.TestCase):
    def test_validation_rejects_missing_action_or_long_push(self):
        for changes in ({"actions": []}, {"notification": "x" * 351}, {"deadline": "bad"}):
            if "deadline" in changes:
                changes = {"actions": [{"text": "task", "deadline": "bad"}]}
            with self.assertRaises(ValueError):
                analysis.validate_result(json.dumps(result(**changes)), "aula-post-1")


if __name__ == "__main__":
    unittest.main()

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import receiver  # noqa: E402


class ReceiverTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.server = receiver.make_server("127.0.0.1", 0, self.folder)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/kadr-probe"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def post(self, body, url=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        request = urllib.request.Request(url or self.url, data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    def test_saves_the_log_under_a_safe_label(self):
        status = self.post({"label": "C1 Online/Mod ../x", "records": [{"type": "create"}]})
        self.assertEqual(status, 200)
        files = os.listdir(self.folder)
        self.assertEqual(len(files), 1)
        self.assertRegex(files[0], r"^\d{8}-\d{6}-C1-Online-Mod-x(-\d+)?\.json$")
        with open(os.path.join(self.folder, files[0]), encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["records"][0]["type"], "create")

    def test_rejects_bad_json_wrong_path_and_huge_body(self):
        self.assertEqual(self.post(b"not json"), 400)
        self.assertEqual(self.post({"records": []}, url=self.url.replace("kadr-probe", "other")), 404)
        self.assertEqual(self.post(b"x" * (receiver.MAX_BYTES + 1)), 413)
        self.assertEqual(os.listdir(self.folder), [])

    def test_only_local_network_clients_are_accepted(self):
        self.assertTrue(receiver.is_local("192.168.1.20"))
        self.assertTrue(receiver.is_local("10.0.0.5"))
        self.assertTrue(receiver.is_local("127.0.0.1"))
        self.assertFalse(receiver.is_local("8.8.8.8"))


if __name__ == "__main__":
    unittest.main()

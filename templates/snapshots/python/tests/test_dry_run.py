import contextlib
import io
import unittest
from unittest.mock import Mock
from bot import run_bot


class DryRun(unittest.TestCase):
    def test_no_credentials_or_api_calls(self):
        client = Mock()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            run_bot({}, client=client, lines=["Hello"])
        self.assertIn("Dry run", output.getvalue())
        self.assertEqual(client.mock_calls, [])

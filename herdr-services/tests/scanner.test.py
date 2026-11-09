#!/usr/bin/env python3
"""Unit tests for services scanner.py logic."""

import os
import sys
import unittest
from pathlib import Path

# Add mod dir to path
MOD_DIR = Path(__file__).resolve().parent.parent / "mods" / "services-inspector"
sys.path.insert(0, str(MOD_DIR))

import scanner


class TestScanner(unittest.TestCase):
    def test_dev_port_detection(self):
        self.assertTrue(scanner.is_dev_port(3000, "node"))
        self.assertTrue(scanner.is_dev_port(5173, "vite"))
        self.assertTrue(scanner.is_dev_port(8000, "uvicorn"))
        self.assertTrue(scanner.is_dev_port(5432, "postgres"))
        self.assertTrue(scanner.is_dev_port(6379, "redis-server"))
        # Protected / system apps should not be dev
        self.assertFalse(scanner.is_dev_port(5000, "ControlCenter"))
        self.assertFalse(scanner.is_dev_port(7000, "ControlCe"))
        self.assertFalse(scanner.is_dev_port(59097, "rapportd"))

    def test_protected_process_detection(self):
        self.assertTrue(scanner.is_protected_process(1, "launchd", "root"))
        self.assertTrue(scanner.is_protected_process(709, "ControlCenter", "andy"))
        self.assertTrue(scanner.is_protected_process(709, "ControlCe", "andy"))
        self.assertTrue(scanner.is_protected_process(778, "rapportd", "andy"))
        self.assertTrue(scanner.is_protected_process(50, "any", "root"))
        # Dev process should NOT be protected
        self.assertFalse(scanner.is_protected_process(65604, "node", "andy"))
        self.assertFalse(scanner.is_protected_process(12345, "vite", "andy"))

    def test_kill_pid_safety(self):
        # PID <= 100 should be rejected
        res_system = scanner.kill_pid(1)
        self.assertFalse(res_system["ok"])
        self.assertIn("system or self", res_system["error"])

        # Current PID should be rejected
        res_self = scanner.kill_pid(os.getpid())
        self.assertFalse(res_self["ok"])
        self.assertIn("system or self", res_self["error"])

        # Non-existent high PID
        res_nonexist = scanner.kill_pid(99999999)
        self.assertFalse(res_nonexist["ok"])
        self.assertIn("does not exist", res_nonexist["error"])

    def test_scan_ports_structure(self):
        ports = scanner.scan_ports()
        self.assertIsInstance(ports, list)
        for p in ports:
            self.assertIn("port", p)
            self.assertIn("pid", p)
            self.assertIn("name", p)
            self.assertIn("isDev", p)
            self.assertIn("isProtected", p)
            self.assertIsInstance(p["port"], int)
            self.assertIsInstance(p["pid"], int)

    def test_scan_docker_structure(self):
        docker = scanner.scan_docker()
        self.assertIsInstance(docker, dict)
        self.assertIn("installed", docker)
        self.assertIn("running", docker)
        self.assertIn("containers", docker)
        self.assertIsInstance(docker["containers"], list)


if __name__ == "__main__":
    unittest.main()

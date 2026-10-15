"""全局路径配置（供 main 与各路由模块共用）。"""
import os

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(BACKEND_DIR)
WEB_DIR = os.path.join(PROJECT_DIR, "web")
UPLOAD_DIR = os.path.join(PROJECT_DIR, "uploads")

os.makedirs(UPLOAD_DIR, exist_ok=True)

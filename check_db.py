import os
import sqlite3

path = r"backend\database\smartmart.db"
print("exists:", os.path.exists(path))
conn = sqlite3.connect(path)
print(conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall())
conn.close()

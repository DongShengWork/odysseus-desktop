"""
update_database.py

此脚本通过向 sessions 表添加新列并填充适当值来更新数据库架构。
它通过检查列是否存在然后尝试添加的方式处理 SQLite 的
ALTER TABLE 操作限制。

添加以下列：
- last_accessed (DateTime): 对现有记录设置为 created_at
- is_important (Boolean): 对现有记录设置为 False
- message_count (Integer): 根据 chat_messages 表中的消息数计算

Usage:
    python update_database.py
"""

import sqlite3
import os
from datetime import datetime
from sqlalchemy import create_engine, inspect, text
from database import DATABASE_URL, SessionLocal, Base

def check_column_exists(engine, table_name, column_name):
    """检查表中是否存在某列。"""
    inspector = inspect(engine)
    columns = inspector.get_columns(table_name)
    return any(col['name'] == column_name for col in columns)

def add_column_sqlite(db_path, table_name, column_name, column_type, default_value=None):
    """
    通过创建新表、复制数据并重命名的方式向 SQLite 表添加列。
    这是必要的，因为 SQLite 的 ALTER TABLE 支持有限。
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # 获取当前表信息
    cursor.execute(f"PRAGMA table_info({table_name})")
    columns = cursor.fetchall()
    column_names = [col[1] for col in columns]
    
    # 创建带附加列的新表
    new_table_name = f"{table_name}_new"
    
    # 构建新列列表
    new_columns = []
    for col in columns:
        new_columns.append(f"{col[1]} {col[2]}")
    
    # 添加新列
    new_column_def = f"{column_name} {column_type}"
    if default_value is not None:
        new_column_def += f" DEFAULT {default_value}"
    new_columns.append(new_column_def)
    
    # 创建新表
    columns_sql = ", ".join(new_columns)
    create_sql = f"CREATE TABLE {new_table_name} ({columns_sql})"
    cursor.execute(create_sql)
    
    # 从旧表复制数据到新表
    column_names_str = ", ".join(column_names)
    insert_sql = f"INSERT INTO {new_table_name} ({column_names_str}) SELECT {column_names_str} FROM {table_name}"
    cursor.execute(insert_sql)
    
    # 删除旧表并重命名新表
    cursor.execute(f"DROP TABLE {table_name}")
    cursor.execute(f"ALTER TABLE {new_table_name} RENAME TO {table_name}")
    
    conn.commit()
    conn.close()

def update_database():
    """更新数据库架构并填充新列。"""
    # 从 DATABASE_URL 创建引擎
    engine = create_engine(DATABASE_URL)
    
    # 从 DATABASE_URL 提取 SQLite 的数据库路径
    db_path = None
    if "sqlite" in DATABASE_URL:
        db_path = DATABASE_URL.replace("sqlite:///", "")
        # 处理相对路径
        if not os.path.isabs(db_path):
            db_path = os.path.join(os.path.dirname(__file__), db_path)
    
    print(f"Updating database at: {DATABASE_URL}")
    
    # 开始事务
    db = SessionLocal()
    try:
        # 如果 last_accessed 列不存在则添加
        if not check_column_exists(engine, 'sessions', 'last_accessed'):
            print("Adding last_accessed column...")
            if db_path:  # SQLite
                add_column_sqlite(db_path, 'sessions', 'last_accessed', 'DATETIME')
            else:  # 其他数据库
                with engine.connect() as conn:
                    conn.execute(text("ALTER TABLE sessions ADD COLUMN last_accessed DATETIME"))
                    conn.commit()
        
        # 如果 is_important 列不存在则添加
        if not check_column_exists(engine, 'sessions', 'is_important'):
            print("Adding is_important column...")
            if db_path:  # SQLite
                add_column_sqlite(db_path, 'sessions', 'is_important', 'BOOLEAN', '0')
            else:  # 其他数据库
                with engine.connect() as conn:
                    conn.execute(text("ALTER TABLE sessions ADD COLUMN is_important BOOLEAN DEFAULT FALSE"))
                    conn.commit()
        
        # 如果 message_count 列不存在则添加
        if not check_column_exists(engine, 'sessions', 'message_count'):
            print("Adding message_count column...")
            if db_path:  # SQLite
                add_column_sqlite(db_path, 'sessions', 'message_count', 'INTEGER', '0')
            else:  # 其他数据库
                with engine.connect() as conn:
                    conn.execute(text("ALTER TABLE sessions ADD COLUMN message_count INTEGER DEFAULT 0"))
                    conn.commit()
        
        # 为 last_accessed 为 NULL 的现有记录填充 created_at
        print("Populating last_accessed column...")
        with engine.connect() as conn:
            conn.execute(text("""
                UPDATE sessions 
                SET last_accessed = created_at 
                WHERE last_accessed IS NULL
            """))
            conn.commit()
        
        # 为 is_important 为 NULL 的现有记录填充 FALSE
        print("Populating is_important column...")
        with engine.connect() as conn:
            conn.execute(text("""
                UPDATE sessions 
                SET is_important = 0 
                WHERE is_important IS NULL
            """))
            conn.commit()
        
        # 从 chat_messages 表计算并填充 message_count
        print("Calculating and populating message_count column...")
        with engine.connect() as conn:
            # 首先，将所有 message_count 设为 0
            conn.execute(text("UPDATE sessions SET message_count = 0"))
            
            # 然后，统计每个会话的消息数并更新
            conn.execute(text("""
                UPDATE sessions 
                SET message_count = (
                    SELECT COUNT(*) 
                    FROM chat_messages 
                    WHERE chat_messages.session_id = sessions.id
                )
            """))
            conn.commit()
        
        print("Database update completed successfully!")
        
    except Exception as e:
        print(f"Error updating database: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    update_database()

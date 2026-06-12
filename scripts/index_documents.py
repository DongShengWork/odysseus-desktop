"""
index_documents.py

一个独立的脚本，将 personal_docs 目录中的文档索引到
使用 RAGManager 的向量数据库中。此脚本扫描文本文件，
使用适当的分块处理它们，并将其添加到向量数据库，
提供进度报告和最终统计信息。

Features:
1. 从 rag_manager 导入 RAGManager
2. 扫描 personal_docs 目录中的 .txt, .md, .json 文件
3. 读取每个文件，进行分块（1000 字符，200 重叠），并添加到向量数据库
4. 显示处理进度和最终统计
"""

import os
import logging
import sys
from pathlib import Path
from typing import List, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.constants import PERSONAL_DIR

# 配置脚本的日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

def main():
    """主函数：从 personal_docs 目录索引文档。"""
    
    # 导入 RAGManager
    try:
        from src.rag_manager import RAGManager
        logger.info("Successfully imported RAGManager")
    except ImportError as e:
        logger.error(f"Failed to import RAGManager: {e}")
        logger.error("Make sure rag_manager.py is in the same directory and accessible")
        return
    
    # 初始化 RAGManager
    rag_manager = RAGManager()
    
    # 要扫描的目录
    docs_directory = PERSONAL_DIR
    directory_path = Path(docs_directory)
    
    # 检查目录是否存在
    if not directory_path.exists():
        logger.error(f"Directory '{docs_directory}' not found!")
        logger.info(f"Please create the directory and add your documents: mkdir {docs_directory}")
        return
    
    # 支持的文件扩展名
    supported_extensions = {'.txt', '.md', '.json'}
    logger.info(f"Scanning '{docs_directory}' for {', '.join(sorted(supported_extensions))} files...")
    
    # 查找所有支持的文件
    files_to_index = []
    for ext in supported_extensions:
        files_to_index.extend(directory_path.rglob(f"*{ext}"))
    
    # 排序文件以保持处理顺序一致
    files_to_index.sort()
    
    if not files_to_index:
        logger.warning(f"No supported files found in '{docs_directory}' directory.")
        logger.info("Add .txt, .md, or .json files to the directory and run this script again.")
        return
    
    logger.info(f"Found {len(files_to_index)} files to index:")
    for file_path in files_to_index:
        logger.info(f"  - {file_path}")
    
    # 索引文档
    logger.info("\nStarting document indexing process...")
    
    try:
        result = rag_manager.index_personal_documents(docs_directory)
        
        # 显示结果
        logger.info("\n" + "="*50)
        if result["success"]:
            logger.info("✅ Document indexing completed successfully!")
            logger.info(f"   Indexed {result['indexed_count']} document chunks")
            if result.get("failed_count", 0) > 0:
                logger.warning(f"   Failed to process {result['failed_count']} files")
        else:
            logger.error("❌ Document indexing failed!")
            if "message" in result:
                logger.error(f"   Error: {result['message']}")
        
        # 显示最终统计
        logger.info("\n" + "-"*30)
        logger.info("Database Statistics:")
        
        stats = rag_manager.get_stats()
        if "error" not in stats:
            for key, value in stats.items():
                logger.info(f"   {key}: {value}")
        else:
            logger.error(f"   Failed to retrieve statistics: {stats['error']}")
        
        logger.info("="*50)
        
    except Exception as e:
        logger.error(f"Failed to index documents: {e}")
        return

if __name__ == "__main__":
    main()

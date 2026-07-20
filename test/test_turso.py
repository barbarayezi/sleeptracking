import os
from dotenv import load_dotenv

# 加载 .env
load_dotenv()

TURSO_URL = os.environ.get("TURSO_URL")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")

print(f"TURSO_URL: {TURSO_URL}")
print(f"TURSO_AUTH_TOKEN: {'已设置（长度: ' + str(len(TURSO_AUTH_TOKEN)) + '）' if TURSO_AUTH_TOKEN else '未设置'}")

if not TURSO_URL or not TURSO_AUTH_TOKEN:
    print("❌ 环境变量未正确配置！")
    exit(1)

try:
    import libsql
    print("✅ libsql 导入成功")
    
    print("正在连接 Turso...")
    conn = libsql.connect(
        database=TURSO_URL,
        auth_token=TURSO_AUTH_TOKEN,
    )
    print("✅ Turso 连接成功")
    
    # 测试查询
    cursor = conn.execute("SELECT 1")
    result = cursor.fetchone()
    print(f"✅ 查询测试成功: {result}")
    
    # 查看表结构
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    print(f"✅ 数据库中的表: {[t[0] for t in tables]}")
    
    # 查看睡眠记录数量
    cursor = conn.execute("SELECT COUNT(*) FROM sleep_records")
    count = cursor.fetchone()[0]
    print(f"✅ 睡眠记录总数: {count} 条")
    
    # 查看最近5条记录
    cursor = conn.execute("SELECT record_date, record_type, sleep_time, wake_time, sleep_quality FROM sleep_records ORDER BY record_date DESC LIMIT 5")
    rows = cursor.fetchall()
    print("\n📊 最近5条记录:")
    for row in rows:
        print(f"  {row[0]} | {row[1]} | {row[2]} -> {row[3]} | 质量: {row[4]}")
    
    # ========== 新增：查看所有数据 ==========
    print("\n" + "=" * 70)
    print("📊 所有睡眠记录")
    print("=" * 70)
    
    cursor = conn.execute("""
        SELECT id, record_date, record_type, sleep_time, wake_time, 
               classification, sleep_quality, sleep_problems, dream_journal,
               weight, water_cups, steps
        FROM sleep_records 
        ORDER BY record_date DESC, 
                 CASE record_type
                     WHEN 'night' THEN 1
                     WHEN 'segment' THEN 2
                     WHEN 'nap' THEN 3
                 END
    """)
    rows = cursor.fetchall()
    
    for row in rows:
        print(f"\n📝 ID: {row[0]}")
        print(f"   📅 日期: {row[1]} | 类型: {row[2]}")
        print(f"   ⏰ 睡眠: {row[3]} -> {row[4]}")
        print(f"   🏷️  分类: {row[5]} | 质量: {row[6]}")
        if row[7]:
            # 解析 JSON 格式的 sleep_problems
            try:
                import json
                problems = json.loads(row[7])
                print(f"   ⚠️  问题: {', '.join(problems)}")
            except:
                print(f"   ⚠️  问题: {row[7]}")
        if row[8]:
            print(f"   📓 日有所感: {row[8][:100]}{'...' if len(row[8]) > 100 else ''}")
        if row[9] is not None:
            print(f"   ⚖️  体重: {row[9]} kg")
        if row[10] is not None:
            print(f"   💧 喝水: {row[10]} 杯")
        if row[11] is not None:
            print(f"   👣 步数: {row[11]}")
    
    print("\n" + "=" * 70)
    print("🍽️ 所有饮食记录")
    print("=" * 70)
    
    cursor = conn.execute("""
        SELECT id, meal_date, meal_type, meal_time, meal_name, 
               meal_content, meal_quantity, health_rating, notes, allergy_reaction
        FROM meal_records 
        ORDER BY meal_date DESC, 
                 CASE meal_type
                     WHEN 'breakfast' THEN 1
                     WHEN 'lunch' THEN 2
                     WHEN 'dinner' THEN 3
                     WHEN 'snack' THEN 4
                 END,
                 meal_time
    """)
    rows = cursor.fetchall()
    
    if rows:
        for row in rows:
            print(f"\n🍽️  ID: {row[0]}")
            print(f"   📅 日期: {row[1]} | 餐次: {row[2]} | 时间: {row[3]}")
            if row[4]:
                print(f"   📝 名称: {row[4]}")
            if row[5]:
                print(f"   📋 内容: {row[5]}")
            print(f"   📊 份量: {row[6]} | 健康度: {row[7]}")
            if row[8]:
                print(f"   💬 备注: {row[8]}")
            if row[9]:
                print(f"   🤧 过敏反应: {row[9]}")
    else:
        print("   📭 暂无饮食记录")
    
    conn.close()
    print("\n" + "=" * 70)
    print("✅ 所有数据查看完成！")
    
except ImportError as e:
    print(f"❌ 导入 libsql 失败: {e}")
    print("请运行: pip install libsql-experimental")
    
except Exception as e:
    print(f"❌ 连接失败: {e}")
    import traceback
    traceback.print_exc()
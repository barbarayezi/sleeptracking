import os
import json
from dotenv import load_dotenv
from datetime import datetime

# 加载 .env
load_dotenv()

TURSO_URL = os.environ.get("TURSO_URL")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")

if not TURSO_URL or not TURSO_AUTH_TOKEN:
    print("❌ 环境变量未正确配置！")
    exit(1)

try:
    import libsql
    import pandas as pd
    print("✅ 依赖导入成功")
    
    print("正在连接 Turso...")
    conn = libsql.connect(
        database=TURSO_URL,
        auth_token=TURSO_AUTH_TOKEN,
    )
    print("✅ Turso 连接成功")
    
    # ========== 导出睡眠记录 ==========
    print("\n📊 正在导出睡眠记录...")
    
    cursor = conn.execute("""
        SELECT 
            id,
            record_date as '日期',
            record_type as '记录类型',
            sleep_time as '入睡时间',
            wake_time as '醒来时间',
            classification as '分类',
            sleep_quality as '睡眠质量',
            sleep_problems as '睡眠问题',
            dream_journal as '日有所感',
            weight as '体重(kg)',
            water_cups as '喝水(杯)',
            steps as '步数',
            created_at as '创建时间',
            updated_at as '更新时间'
        FROM sleep_records 
        ORDER BY record_date DESC, 
                 CASE record_type
                     WHEN 'night' THEN 1
                     WHEN 'segment' THEN 2
                     WHEN 'nap' THEN 3
                 END
    """)
    
    rows = cursor.fetchall()
    columns = [desc[0] for desc in cursor.description]
    
    # 转换为 DataFrame 并处理数据
    df_sleep = pd.DataFrame(rows, columns=columns)
    
    # 解析 sleep_problems JSON
    def parse_problems(val):
        if not val:
            return ''
        try:
            problems = json.loads(val)
            return ', '.join(problems)
        except:
            return str(val)
    
    df_sleep['睡眠问题'] = df_sleep['睡眠问题'].apply(parse_problems)
    
    print(f"   ✅ 导出睡眠记录: {len(df_sleep)} 条")
    
    # ========== 导出饮食记录 ==========
    print("\n🍽️ 正在导出饮食记录...")
    
    cursor = conn.execute("""
        SELECT 
            id,
            meal_date as '日期',
            meal_type as '餐次',
            meal_time as '用餐时间',
            meal_name as '菜品名称',
            meal_content as '食物内容',
            meal_quantity as '份量',
            health_rating as '健康度',
            notes as '备注',
            allergy_reaction as '过敏反应',
            created_at as '创建时间',
            updated_at as '更新时间'
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
    columns = [desc[0] for desc in cursor.description]
    
    df_meal = pd.DataFrame(rows, columns=columns)
    print(f"   ✅ 导出饮食记录: {len(df_meal)} 条")
    
    conn.close()
    
    # ========== 导出到 Excel ==========
    print("\n📁 正在生成 Excel 文件...")
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f"sleep_data_export_{timestamp}.xlsx"
    
    with pd.ExcelWriter(filename, engine='openpyxl') as writer:
        df_sleep.to_excel(writer, sheet_name='睡眠记录', index=False)
        df_meal.to_excel(writer, sheet_name='饮食记录', index=False)
        
        # 调整列宽
        for sheet_name in writer.sheets:
            worksheet = writer.sheets[sheet_name]
            for column in worksheet.columns:
                max_length = 0
                column_letter = column[0].column_letter
                for cell in column:
                    try:
                        if len(str(cell.value)) > max_length:
                            max_length = len(str(cell.value))
                    except:
                        pass
                adjusted_length = min(max_length + 2, 50)
                worksheet.column_dimensions[column_letter].width = adjusted_length
    
    print(f"\n✅ 导出完成！")
    print(f"   📄 文件: {filename}")
    print(f"   📊 睡眠记录: {len(df_sleep)} 条")
    print(f"   🍽️  饮食记录: {len(df_meal)} 条")
    
except ImportError as e:
    print(f"❌ 导入失败: {e}")
    if 'pandas' in str(e):
        print("请运行: pip install pandas openpyxl")
    elif 'libsql' in str(e):
        print("请运行: pip install libsql-experimental")
    
except Exception as e:
    print(f"❌ 导出失败: {e}")
    import traceback
    traceback.print_exc()
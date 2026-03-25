import png
from PIL import Image
import io
import os
import struct
import zlib

def clone_all_metadata_chunks(ref_path):
    """提取参考图中的所有元数据块，跳过核心像素控制块"""
    meta_chunks = []
    with open(ref_path, 'rb') as f:
        reader = png.Reader(file=f)
        try:
            for chunk_type, chunk_data in reader.chunks():
                # 核心：保留 iCCP (色彩), cICP (HDR标准), eXIf (苹果增益参数)
                if chunk_type not in [b'IHDR', b'IDAT', b'IEND', b'PLTE']:
                    meta_chunks.append((chunk_type, chunk_data))
                    print(f"成功克隆基因块: {chunk_type.decode('ascii', errors='ignore')}")
        except Exception as e:
            print(f"读取参考图出错: {e}")
    return meta_chunks

def convert_to_ultra_hdr_png(input_png, ref_png, output_name):
    # 1. 提取参考图的所有 HDR 基因
    metadata_chunks = clone_all_metadata_chunks(ref_png)
    
    # 2. 用 Pillow 生成一个干净的 RGBA 8-bit 底图字节流
    img = Image.open(input_png).convert("RGBA")
    temp_buffer = io.BytesIO()
    img.save(temp_buffer, format="PNG")
    temp_data = temp_buffer.getvalue()
    
    output_path = output_name + "_Ultimate_HDR.png"
    
    # 3. 缝合手术：将基因注入底图
    with open(output_path, 'wb') as f:
        # 写入 PNG 签名 (8 bytes)
        f.write(b'\x89PNG\r\n\x1a\n')
        
        # 寻找并写入原图的 IHDR 块 (通常紧跟在签名后)
        # 手动寻找第一个块
        reader = png.Reader(bytes=temp_data)
        chunks = list(reader.chunks())
        
        # 写入 IHDR
        ihdr_type, ihdr_data = chunks[0]
        f.write(struct.pack('>I', len(ihdr_data)) + ihdr_type + ihdr_data + 
                struct.pack('>I', zlib.crc32(ihdr_type + ihdr_data) & 0xffffffff))
        
        # 4. 注入克隆的 HDR 基因 (iCCP, cICP, eXIf 等)
        for c_type, c_data in metadata_chunks:
            f.write(struct.pack('>I', len(c_data)) + c_type + c_data + 
                    struct.pack('>I', zlib.crc32(c_type + c_data) & 0xffffffff))
        
        # 5. 写入剩余的块 (IDAT 像素数据 和 IEND 结尾)
        for c_type, c_data in chunks[1:]:
            f.write(struct.pack('>I', len(c_data)) + c_type + c_data + 
                    struct.pack('>I', zlib.crc32(c_type + c_data) & 0xffffffff))

    print(f"\n--- 任务达成 ---")
    print(f"HDR 基因已注入表情包：{output_path}")

if __name__ == "__main__":
    input_file = "inputPNG1.png"
    reference_file = "Ref.png"
    
    if os.path.exists(input_file) and os.path.exists(reference_file):
        convert_to_ultra_hdr_png(input_file, reference_file, "Result_0535_Bright")
    else:
        print("错误：请确保文件夹内有 inputPNG.png 和 Ref.png")

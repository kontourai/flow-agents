# Descriptor-relative inspection: directory replacement/symlink races cannot traverse host paths.
import json, os, stat, sys
policy=json.loads(sys.argv[1]); totals={'bytes':0,'entries':0,'largest':0};reason=None;free=None;devices=set()
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW

def visit(fd):
 global reason
 with os.scandir(fd) as entries:
  for entry in entries:
   totals['entries']+=1
   try: info=entry.stat(follow_symlinks=False)
   except FileNotFoundError: continue
   if stat.S_ISDIR(info.st_mode):
    try: child=os.open(entry.name,flags,dir_fd=fd)
    except FileNotFoundError: continue
    except OSError: reason='unsupported_writable_directory';return
    try: visit(child)
    finally: os.close(child)
   elif stat.S_ISREG(info.st_mode):
    totals['bytes']+=info.st_size;totals['largest']=max(totals['largest'],info.st_size)
   else: reason='unsupported_writable_entry';return
   if reason or totals['entries']>policy['max_entries'] or totals['bytes']>policy['max_bytes'] or totals['largest']>policy['max_file_bytes']: return

for root in policy['roots']:
 fd=os.open(root,flags)
 try:
  info=os.fstat(fd);space=os.fstatvfs(fd)
  if info.st_dev not in devices:
   devices.add(info.st_dev);value=space.f_bavail*space.f_frsize;free=value if free is None else min(free,value)
  visit(fd)
 finally: os.close(fd)
 if reason: break
if not reason:
 if free<policy['min_free_bytes']:reason='filesystem_free_floor'
 elif totals['bytes']>policy['max_bytes']:reason='writable_byte_budget'
 elif totals['entries']>policy['max_entries']:reason='writable_entry_budget'
 elif totals['largest']>policy['max_file_bytes']:reason='writable_file_budget'
print(json.dumps({'allowed':reason is None,'reason':reason,'observed_bytes':totals['bytes'],'observed_entries':totals['entries'],'largest_file_bytes':totals['largest'],'free_bytes':free,'budget':{key:policy[key] for key in ['max_bytes','max_entries','max_file_bytes','min_free_bytes']}}))

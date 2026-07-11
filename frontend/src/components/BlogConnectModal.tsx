import { useEffect, useState } from 'react';
import { Checkbox, Input, Modal, Toast } from '@douyinfe/semi-ui';
import { loadBlogConnection, testBlogConnection, type BlogConnection } from '../lib/blogClient';

export function BlogConnectModal({
  visible,
  onClose,
  onConnected,
}: {
  visible: boolean;
  onClose: () => void;
  onConnected: (conn: BlogConnection) => void;
}) {
  const [url, setUrl] = useState('http://127.0.0.1:8090');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) {
      return;
    }
    void loadBlogConnection().then((cfg) => {
      if (!cfg) {
        return;
      }
      setUrl(cfg.url || 'http://127.0.0.1:8090');
      setUsername(cfg.username || '');
      setRememberPassword(Boolean(cfg.rememberPassword));
      if (cfg.rememberPassword && cfg.password) {
        setPassword(cfg.password);
      }
    });
  }, [visible]);

  const handleOk = async () => {
    if (!url.trim() || !username.trim() || !password) {
      Toast.warning('请填写 Blog URL、用户名和密码');
      return;
    }
    setLoading(true);
    try {
      const conn = await testBlogConnection({
        url: url.trim(),
        username: username.trim(),
        password,
        rememberPassword,
      });
      Toast.success('连接成功');
      onConnected(conn);
      onClose();
    } catch (error) {
      Toast.error(`连接失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="连接到 Blog"
      visible={visible}
      okText="连接并测试"
      cancelText="取消"
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={loading}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input prefix="URL" value={url} onChange={setUrl} placeholder="http://127.0.0.1:8090" />
        <Input prefix="用户" value={username} onChange={setUsername} placeholder="用户名" />
        <Input mode="password" prefix="密码" value={password} onChange={setPassword} placeholder="密码" />
        <Checkbox checked={rememberPassword} onChange={(e) => setRememberPassword(Boolean(e.target.checked))}>
          记住密码（保存在本地配置，注意安全风险）
        </Checkbox>
      </div>
    </Modal>
  );
}

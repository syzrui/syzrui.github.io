upTime = (time) => {
    let timed = new Date(time).getTime()
    let nowTime = new Date().getTime()
    let timeDiff = Math.floor(((nowTime - timed) / 1000))
    let minutes = Math.floor(timeDiff / 60)
    let hours = Math.floor(minutes / 60)
    let days = Math.floor(hours / 24)
    if (days <= 3) {
        if (timeDiff < 20) {
            return '刚刚'
        } else if (timeDiff < 60) {
            return `${timeDiff}秒前`
        } else if (minutes < 60) {
            return `${minutes}分钟前`
        } else if (hours < 24) {
            return `${hours}小时前`
        } else {
            return `${days}天前`
        }
    } else if (days <= 7) {
        return `${days}天前`
    } else if (days <= 30) {
        return `${Math.floor(days / 7)}周前`
    } else if (days <= 365) {
        return `${Math.floor(days / 30)}月前`
    } else {
        return `${Math.floor(days / 365)}年前`
    }
}

// 存储localStorage
const setStore = (name, content) => {
    if (!name) return;
    if (typeof content !== 'string') {
        content = JSON.stringify(content);
    }
    window.localStorage.setItem(name, content);
}

// 获取localStorage
const getStore = name => {
    if (!name) return
    return window.localStorage.getItem(name)
}

// 删除localStorage
const removeStore = name => {
    if (!name) return
    window.localStorage.removeItem(name)
}

// 设置cookie
const setCookie = (name, value, day) => {
    if (!name) return
    if (day) {
        let date = new Date();
        date.setTime(date.getTime() + day * 24 * 60 * 60 * 1000);
        document.cookie = name + '=' + value + ';expires=' + date.toUTCString();
    } else {
        document.cookie = name + '=' + value;
    }
}

// 获取cookie
const getCookie = name => {
    if (!name) return
    let reg = new RegExp(name + '=([^;]*)(;|$)');
    let arr = document.cookie.match(reg);
    if (arr) {
        return arr[1];
    } else {
        return null;
    }
}

// 删除cookie
const removeCookie = name => {
    if (!name) return
    setCookie(name, '', -1);
}

; (function () {
    let elList = []
    let position = {
        beforeTop: 0,
        top: 20
    }
    /*
    message	            消息文字	string / VNode	—	—
    type	            主题	string	success/warning/info/error	info
    duration	        显示时间, 毫秒。设为 0 则不会自动关闭	number	—	3000
    showClose	        是否显示关闭按钮	boolean	—	false
    center	            文字是否居中	boolean	—	false
    onClose	            关闭时的回调函数, 参数为被关闭的 message 实例	function	—	—
    */
    /**
     *
     * @param {{ message: Text [不可为空], type: 'info, success, warning, error' [可为空], duration: ms [可为空], showClose: Boolean [可为空], center: Boolean [可为空], onClose: Function [可为空] }} opt
     */
    function _message({ message = '', type = 'info', duration = 2500, showClose = false, center = false, onClose = null }) {
        let el = document.createElement('div')
        el.className = `message ${showClose ? 'showClose' : ''} ${center ? 'center' : ''} ${type}`
        el.style.top = position.beforeTop + 'px'
        el.style.opacity = 0
        el.innerHTML = `<span class="iconfont icon-${type} ${type}"></span>
                    <span class="message-body">
                        ${message}
                    </span>
                    <span></span>
                    <span class="icon-close close"></span>`
        elList.push({
            el: el,
            top: position.top,
            beforeTop: position.beforeTop
        })
        setTimeout(() => {
            el.style.top = position.top + 'px'
            el.style.opacity = 1
            position.beforeTop += 66
            position.top += 66
        }, 10);

        el.querySelector('.close').addEventListener('click', _close)

        setTimeout(() => {
            _close()
        }, duration);

        function _close() {
            el.style.opacity = 0
            if (onClose) onClose();
            setTimeout(() => {
                el.remove()
                let index = elList.findIndex(v => v.el == el)
                elList.forEach((v, i) => {
                    if (v.el == el) {
                        elList.splice(i, 1)
                    }
                })
                elList.forEach((v, i) => {
                    if (i >= index) {
                        v.el.style.top = (v.top - 66) + 'px'
                        v.top -= 66
                        v.beforeTop -= 66
                    }
                })
                if (elList.length >= 0) {
                    // console.log({...elList})
                    position.top = elList.length > 0 ? elList[elList.length - 1].top + 66 : 20
                    position.beforeTop = elList.length > 0 ? elList[elList.length - 1].beforeTop + 66 : 0
                    // console.log(position)
                }
            }, 200);
        }

        document.querySelector('body').appendChild(el)

    }

    window.message = _message
})()

console.version = (version) => {
    console.log(`%cversion%c: %c${version}`, `
    color: #409EFF;
    background: #d4e8ff;
    padding: 1px 6px;
    border-radius: 5px 0 0 5px;
    font-size: 11px;
    line-height: 16px;
    height: 16px;
    border: 1px solid #d4e8ff;
    margin: 1.5px 0 4px 0px;
    box-sizing: border-box;
    text-align: center`, `
    font-size: 0px`, `
    color: #409EFF;
    background: #ffffff;
    padding: 1px 6px;
    border-radius: 0 5px 5px 0;
    font-size: 11px;
    line-height: 16px;
    height: 16px;
    border: 1px solid #d4e8ff;
    margin: 1.5px 0 4px 0;
    box-sizing: border-box`)
}